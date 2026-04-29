importScripts("api.js");

const api = getBrowserApi();
const activePageRuns = new Map();
const activePageAbortControllers = new Map();
const PAGE_BATCH_SIZE = 6;

function storageGetLocal(defaults) {
  if (api.storage && api.storage.local && api.storage.local.get.length === 1) {
    return api.storage.local.get(defaults);
  }
  return new Promise((resolve) => api.storage.local.get(defaults, resolve));
}

function storageSetLocal(values) {
  if (api.storage && api.storage.local && api.storage.local.set.length === 1) {
    return api.storage.local.set(values);
  }
  return new Promise((resolve) => api.storage.local.set(values, resolve));
}

async function setImmersiveModeEnabled(enabled) {
  await storageSetLocal({ immersiveModeEnabled: Boolean(enabled) });
}

async function getImmersiveModeEnabled() {
  const saved = await storageGetLocal({ immersiveModeEnabled: false });
  return Boolean(saved?.immersiveModeEnabled);
}

async function ensureContentScript(tabId) {
  if (!tabId) throw new Error("找不到当前标签页。");
  try {
    await sendMessageToTab(tabId, { type: "PING" });
    return;
  } catch (_) {
  }

  if (!api.scripting?.executeScript) {
    throw new Error("当前浏览器不支持按需注入脚本。");
  }

  await api.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });
  await sendMessageToTab(tabId, { type: "PING" });
}

function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    try {
      const result = api.tabs.sendMessage(tabId, message, (response) => {
        const err = typeof chrome !== "undefined" ? chrome.runtime?.lastError : undefined;
        if (err) reject(new Error(err.message));
        else resolve(response);
      });
      if (result && typeof result.then === "function") result.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function queryActiveTab() {
  return new Promise((resolve, reject) => {
    try {
      const result = api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const err = typeof chrome !== "undefined" ? chrome.runtime?.lastError : undefined;
        if (err) reject(new Error(err.message));
        else resolve(tabs?.[0]);
      });
      if (result && typeof result.then === "function") result.then((tabs) => resolve(tabs?.[0]), reject);
    } catch (error) {
      reject(error);
    }
  });
}

function runtimeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (_) {
    // The popup may have closed before the async operation returned.
  }
}

function removeAllContextMenus() {
  return new Promise((resolve) => {
    try {
      const result = api.contextMenus.removeAll(() => resolve());
      if (result && typeof result.then === "function") result.then(resolve, resolve);
    } catch (_) {
      resolve();
    }
  });
}

async function createContextMenus() {
  // Rebuild menus every time so Safari/Chrome dev reloads do not keep stale titles.
  await removeAllContextMenus();
  const menus = [
    {
      id: "translate-selection",
      title: "Transjux them",
      contexts: ["selection"]
    },
    {
      id: "translate-page",
      title: "Transjux this page",
      contexts: ["page"]
    },
    {
      id: "restore-page",
      title: "Restore Transjux page translation",
      contexts: ["page"]
    }
  ];

  for (const menu of menus) {
    try {
      api.contextMenus.create(menu);
    } catch (_) {
      // Some Safari builds can keep menus during rapid dev reloads.
    }
  }
}

async function translateAndShow(tab, sourceText) {
  if (!tab?.id) throw new Error("找不到当前标签页。");
  await ensureContentScript(tab.id);
  const text = String(sourceText || "").trim();
  if (!text) {
    await sendMessageToTab(tab.id, { type: "SHOW_TRANSLATION", error: "请先在网页中选中要翻译的文本。" });
    return;
  }

  await sendMessageToTab(tab.id, { type: "SHOW_TRANSLATION", loading: true, source: text });
  try {
    const translation = await translateText(text);
    await sendMessageToTab(tab.id, { type: "SHOW_TRANSLATION", source: text, translation });
  } catch (error) {
    await sendMessageToTab(tab.id, { type: "SHOW_TRANSLATION", source: text, error: error.message || String(error) });
  }
}

function makeRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function translateCurrentPage(tab) {
  if (!tab?.id) throw new Error("找不到当前标签页。");
  await ensureContentScript(tab.id);

  const runId = makeRunId();
  const abortController = new AbortController();
  activePageRuns.set(tab.id, runId);
  activePageAbortControllers.set(tab.id, abortController);

  let blocks = [];
  try {
    const response = await sendMessageToTab(tab.id, { type: "GET_PAGE_BLOCKS", runId });
    blocks = response?.blocks || [];
  } catch (error) {
    activePageRuns.delete(tab.id);
    throw new Error("无法读取当前页面正文。请确认 Safari 已允许此扩展访问该网站。");
  }

  if (!blocks.length) {
    activePageRuns.delete(tab.id);
    await sendMessageToTab(tab.id, {
      type: "PAGE_TRANSLATION_STATUS",
      runId,
      status: "error",
      message: "没有找到适合翻译的正文段落。"
    });
    return { ok: false, count: 0 };
  }

  await sendMessageToTab(tab.id, {
    type: "PAGE_TRANSLATION_STATUS",
    runId,
    status: "running",
    done: 0,
    total: blocks.length,
    message: `正在翻译 0/${blocks.length}`
  });

  let done = 0;
  for (let i = 0; i < blocks.length; i += PAGE_BATCH_SIZE) {
    if (activePageRuns.get(tab.id) !== runId) {
      activePageAbortControllers.delete(tab.id);
      await sendMessageToTab(tab.id, {
        type: "PAGE_TRANSLATION_STATUS",
        runId,
        status: "cancelled",
        done,
        total: blocks.length,
        message: `已停止，已完成 ${done}/${blocks.length}`
      }).catch(() => {});
      return { ok: false, cancelled: true, count: done };
    }

    const batch = blocks.slice(i, i + PAGE_BATCH_SIZE);
    await sendMessageToTab(tab.id, {
      type: "PAGE_TRANSLATION_STATUS",
      runId,
      status: "running",
      done,
      total: blocks.length,
      message: `正在翻译 ${done}/${blocks.length}`
    }).catch(() => {});

    try {
      const translations = await translatePageBlocks(batch, {}, { signal: abortController.signal });
      if (activePageRuns.get(tab.id) !== runId) {
        activePageAbortControllers.delete(tab.id);
        await sendMessageToTab(tab.id, {
          type: "PAGE_TRANSLATION_STATUS",
          runId,
          status: "cancelled",
          done,
          total: blocks.length,
          message: `已停止，已完成 ${done}/${blocks.length}`
        }).catch(() => {});
        return { ok: false, cancelled: true, count: done };
      }
      done += translations.filter((item) => item.text).length;
      await sendMessageToTab(tab.id, {
        type: "PAGE_TRANSLATION_BATCH",
        runId,
        translations,
        done,
        total: blocks.length
      });
    } catch (error) {
      await sendMessageToTab(tab.id, {
        type: "PAGE_TRANSLATION_STATUS",
        runId,
        status: "error",
        done,
        total: blocks.length,
        message: error.message || String(error)
      }).catch(() => {});
      activePageRuns.delete(tab.id);
      activePageAbortControllers.delete(tab.id);
      if (error?.name === "AbortError") {
        await sendMessageToTab(tab.id, {
          type: "PAGE_TRANSLATION_STATUS",
          runId,
          status: "cancelled",
          done,
          total: blocks.length,
          message: `已停止，已完成 ${done}/${blocks.length}`
        }).catch(() => {});
        return { ok: false, cancelled: true, count: done };
      }
      throw error;
    }
  }

  if (activePageRuns.get(tab.id) === runId) {
    activePageRuns.delete(tab.id);
    activePageAbortControllers.delete(tab.id);
    await sendMessageToTab(tab.id, {
      type: "PAGE_TRANSLATION_DONE",
      runId,
      done,
      total: blocks.length,
      message: `完成 ${done}/${blocks.length}`
    });
  }

  activePageAbortControllers.delete(tab.id);
  return { ok: true, count: done };
}

api.runtime.onInstalled.addListener(createContextMenus);
createContextMenus();

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "translate-selection") {
    await translateAndShow(tab, info.selectionText);
    return;
  }

  if (info.menuItemId === "translate-page") {
    await translateCurrentPage(tab).catch((error) => {
      if (tab?.id) {
        sendMessageToTab(tab.id, {
          type: "PAGE_TRANSLATION_STATUS",
          status: "error",
          message: error.message || String(error)
        }).catch(() => {});
      }
    });
    return;
  }

  if (info.menuItemId === "restore-page" && tab?.id) {
    activePageRuns.delete(tab.id);
    activePageAbortControllers.get(tab.id)?.abort();
    activePageAbortControllers.delete(tab.id);
    await sendMessageToTab(tab.id, { type: "RESTORE_PAGE_TRANSLATION" }).catch(() => {});
  }
});

api.commands.onCommand.addListener(async (command) => {
  const tab = await queryActiveTab();
  if (!tab?.id && command !== "toggle-immersive-mode") return;

  if (command === "toggle-immersive-mode") {
    const nextEnabled = !(await getImmersiveModeEnabled());
    await setImmersiveModeEnabled(nextEnabled);
    if (tab?.id) {
      await ensureContentScript(tab.id).catch(() => {});
      await sendMessageToTab(tab.id, { type: "IMMERSIVE_MODE_CHANGED", enabled: nextEnabled }).catch(() => {});
    }
    return;
  }

  if (command === "translate-selection") {
    try {
      await ensureContentScript(tab.id);
      const response = await sendMessageToTab(tab.id, { type: "GET_SELECTION" });
      await translateAndShow(tab, response?.text || "");
    } catch (error) {
      await sendMessageToTab(tab.id, { type: "SHOW_TRANSLATION", error: "无法读取当前网页选区。请确认 Safari 已允许此扩展访问该网站。" });
    }
  }

  if (command === "translate-page") {
    await translateCurrentPage(tab).catch((error) => {
      sendMessageToTab(tab.id, {
        type: "PAGE_TRANSLATION_STATUS",
        status: "error",
        message: error.message || String(error)
      }).catch(() => {});
    });
  }
});

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_PAGE_TRANSLATION") {
    const tabId = message.tabId;
    if (!tabId) {
      runtimeSendResponse(sendResponse, { ok: false, error: "找不到当前标签页。" });
      return true;
    }

    translateCurrentPage({ id: tabId })
      .then((result) => runtimeSendResponse(sendResponse, result))
      .catch((error) => runtimeSendResponse(sendResponse, { ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "CANCEL_PAGE_TRANSLATION") {
    const tabId = sender?.tab?.id || message.tabId;
    if (tabId) activePageRuns.delete(tabId);
    if (tabId) activePageAbortControllers.get(tabId)?.abort();
    if (tabId) activePageAbortControllers.delete(tabId);
    runtimeSendResponse(sendResponse, { ok: true });
    return true;
  }

  if (message?.type === "RESTORE_PAGE_TRANSLATION") {
    const tabId = message.tabId;
    if (tabId) activePageRuns.delete(tabId);
    if (tabId) activePageAbortControllers.get(tabId)?.abort();
    if (tabId) activePageAbortControllers.delete(tabId);
    if (!tabId) {
      runtimeSendResponse(sendResponse, { ok: false, error: "找不到当前标签页。" });
      return true;
    }
    ensureContentScript(tabId)
      .then(() => sendMessageToTab(tabId, { type: "RESTORE_PAGE_TRANSLATION" }))
      .then((response) => runtimeSendResponse(sendResponse, response || { ok: true }))
      .catch((error) => runtimeSendResponse(sendResponse, { ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "AUTO_TRANSLATE_SELECTION") {
    const tabId = sender?.tab?.id;
    const source = String(message.text || "").trim();
    if (!tabId) {
      runtimeSendResponse(sendResponse, { ok: false, error: "找不到当前标签页。" });
      return true;
    }
    translateAndShow({ id: tabId }, source)
      .then(() => runtimeSendResponse(sendResponse, { ok: true }))
      .catch((error) => runtimeSendResponse(sendResponse, { ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "TRANSLATE_PAGE_BLOCKS") {
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    translatePageBlocks(blocks)
      .then((translations) => runtimeSendResponse(sendResponse, { ok: true, translations }))
      .catch((error) => runtimeSendResponse(sendResponse, { ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message?.type === "IMMERSIVE_MODE_CHANGED") {
    setImmersiveModeEnabled(Boolean(message.enabled))
      .then(() => runtimeSendResponse(sendResponse, { ok: true }))
      .catch((error) => runtimeSendResponse(sendResponse, { ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});
