const api = getBrowserApi();
const sourceEl = document.getElementById("source");
const resultEl = document.getElementById("result");
const statusEl = document.getElementById("status");
const translateBtn = document.getElementById("translate");
const copyBtn = document.getElementById("copy");
const translatePageBtn = document.getElementById("translatePage");
const restorePageBtn = document.getElementById("restorePage");
const activeProfileEl = document.getElementById("activeProfile");
const serviceSelectEl = document.getElementById("serviceSelect");
const immersiveToggleEl = document.getElementById("immersiveToggle");
let cachedProfiles = [];
let activeProfileId = DEFAULT_PROFILE_ID;

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

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      const result = api.runtime.sendMessage(message, (response) => {
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
}

async function loadActiveProfile() {
  try {
    const settings = await getSettings();
    cachedProfiles = settings.apiProfiles || [];
    activeProfileId = settings.activeProfileId || DEFAULT_PROFILE_ID;
    const profile = settings.activeProfile || settings;
    renderServiceSelector(cachedProfiles, activeProfileId);
    activeProfileEl.textContent = `当前服务：${profile.name || profile.model || "未命名配置"}`;
    activeProfileEl.title = profile.provider === "microsoft-free"
      ? `Microsoft Translator · ${profile.targetLanguage || "zh-Hans"}`
      : `${profile.baseUrl || "未填写 Base URL"} · ${profile.model || "未填写 Model"}`;
  } catch (_) {
    activeProfileEl.textContent = "当前服务：读取失败";
    serviceSelectEl.innerHTML = "";
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "读取失败";
    serviceSelectEl.appendChild(option);
    serviceSelectEl.disabled = true;
  }
}

async function loadImmersiveToggle() {
  try {
    const saved = await storageGetLocal({ immersiveModeEnabled: false });
    const enabled = Boolean(saved?.immersiveModeEnabled);
    immersiveToggleEl.dataset.enabled = enabled ? "true" : "false";
    immersiveToggleEl.classList.toggle("active", enabled);
  } catch (_) {
    immersiveToggleEl.dataset.enabled = "false";
    immersiveToggleEl.classList.remove("active");
  }
}

async function setImmersiveMode(enabled) {
  const value = Boolean(enabled);
  immersiveToggleEl.disabled = true;
  try {
    await storageSetLocal({ immersiveModeEnabled: value });
    immersiveToggleEl.dataset.enabled = value ? "true" : "false";
    immersiveToggleEl.classList.toggle("active", value);
    const tab = await queryActiveTab();
    if (tab?.id) {
      await ensureContentScript(tab.id);
      await sendMessageToTab(tab.id, { type: "IMMERSIVE_MODE_CHANGED", enabled: value }).catch(() => {});
    }
    await sendRuntimeMessage({ type: "IMMERSIVE_MODE_CHANGED", enabled: value }).catch(() => {});
    statusEl.textContent = value ? "沉浸式阅读已开启。" : "沉浸式阅读已关闭。";
  } catch (error) {
    immersiveToggleEl.dataset.enabled = (!value) ? "true" : "false";
    immersiveToggleEl.classList.toggle("active", !value);
    statusEl.textContent = error.message || String(error);
  } finally {
    immersiveToggleEl.disabled = false;
  }
}

function renderServiceSelector(profiles, currentActiveId) {
  serviceSelectEl.innerHTML = "";
  const list = Array.isArray(profiles) ? profiles : [];
  if (!list.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用服务";
    serviceSelectEl.appendChild(option);
    serviceSelectEl.disabled = true;
    return;
  }
  for (const profile of list) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.name || profile.model || "未命名配置";
    serviceSelectEl.appendChild(option);
  }
  const hasActive = list.some((profile) => profile.id === currentActiveId);
  serviceSelectEl.value = hasActive ? currentActiveId : list[0].id;
  serviceSelectEl.disabled = list.length <= 1;
}

async function switchService() {
  const nextProfileId = serviceSelectEl.value;
  if (!nextProfileId || nextProfileId === activeProfileId) {
    statusEl.textContent = "服务未变化。";
    return;
  }

  serviceSelectEl.disabled = true;
  statusEl.textContent = "正在切换服务...";
  try {
    const normalized = await saveApiProfiles(cachedProfiles, nextProfileId);
    cachedProfiles = normalized.apiProfiles || [];
    activeProfileId = normalized.activeProfileId || DEFAULT_PROFILE_ID;
    renderServiceSelector(cachedProfiles, activeProfileId);
    const profile = normalized.activeProfile || {};
    activeProfileEl.textContent = `当前服务：${profile.name || profile.model || "未命名配置"}`;
    activeProfileEl.title = profile.provider === "microsoft-free"
      ? `Microsoft Translator · ${profile.targetLanguage || "zh-Hans"}`
      : `${profile.baseUrl || "未填写 Base URL"} · ${profile.model || "未填写 Model"}`;
    statusEl.textContent = "已切换服务。";
  } catch (error) {
    statusEl.textContent = error.message || String(error);
  } finally {
    serviceSelectEl.disabled = cachedProfiles.length <= 1;
  }
}

async function loadSelection() {
  try {
    const tab = await queryActiveTab();
    if (!tab?.id) return;
    await ensureContentScript(tab.id);
    const response = await sendMessageToTab(tab.id, { type: "GET_SELECTION" });
    if (response?.text) sourceEl.value = response.text;
  } catch (_) {
    statusEl.textContent = "没有读取到网页选区；可直接粘贴文本。";
  }
}

async function doTranslate() {
  const text = sourceEl.value.trim();
  if (!text) {
    statusEl.textContent = "请先选中或粘贴要翻译的文本。";
    return;
  }

  translateBtn.disabled = true;
  statusEl.textContent = "正在调用当前 API...";
  resultEl.textContent = "";

  try {
    const translated = await translateText(text);
    resultEl.textContent = translated;
    statusEl.textContent = "完成";
  } catch (error) {
    resultEl.textContent = error.message || String(error);
    statusEl.textContent = "失败";
  } finally {
    translateBtn.disabled = false;
  }
}

async function doTranslatePage() {
  translatePageBtn.disabled = true;
  statusEl.textContent = "已开始翻译当前页；进度会显示在页面底部。";

  try {
    const tab = await queryActiveTab();
    if (!tab?.id) throw new Error("找不到当前标签页。");
    const response = await sendRuntimeMessage({ type: "START_PAGE_TRANSLATION", tabId: tab.id });
    if (!response?.ok && response?.error) throw new Error(response.error);
    statusEl.textContent = response?.cancelled ? "页面翻译已停止。" : `页面翻译完成：${response?.count || 0} 段。`;
  } catch (error) {
    statusEl.textContent = error.message || String(error);
  } finally {
    translatePageBtn.disabled = false;
  }
}

async function doRestorePage() {
  statusEl.textContent = "正在还原页面翻译...";
  try {
    const tab = await queryActiveTab();
    if (!tab?.id) throw new Error("找不到当前标签页。");
    const response = await sendRuntimeMessage({ type: "RESTORE_PAGE_TRANSLATION", tabId: tab.id });
    if (!response?.ok && response?.error) throw new Error(response.error);
    statusEl.textContent = "已还原页面翻译。";
  } catch (error) {
    statusEl.textContent = error.message || String(error);
  }
}

translateBtn.addEventListener("click", doTranslate);
copyBtn.addEventListener("click", async () => {
  const text = resultEl.textContent.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  statusEl.textContent = "已复制";
});
translatePageBtn.addEventListener("click", doTranslatePage);
restorePageBtn.addEventListener("click", doRestorePage);
serviceSelectEl.addEventListener("change", switchService);
immersiveToggleEl.addEventListener("click", () => {
  const next = immersiveToggleEl.dataset.enabled !== "true";
  immersiveToggleEl.dataset.enabled = next ? "true" : "false";
  immersiveToggleEl.classList.toggle("active", next);
  setImmersiveMode(next);
});

loadActiveProfile();
loadImmersiveToggle();
loadSelection();
