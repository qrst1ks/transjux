const MLX_HOST_ID = "local-mlx-translate-host";
const MLX_PAGE_STYLE_ID = "local-mlx-page-style";
const MLX_PAGE_TRANSLATION_ATTR = "data-local-mlx-page-translation";
const MLX_PAGE_BLOCK_ATTR = "data-local-mlx-page-block-id";
const MLX_IMMERSIVE_DOT_ID = "local-mlx-immersive-dot";
const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULT_BUBBLE_WIDTH = 560;
const DEFAULT_BUBBLE_HEIGHT = 0; // 0 means auto height until the user resizes it.
const MIN_BUBBLE_WIDTH = 280;
const MAX_BUBBLE_WIDTH = 860;
const MIN_BUBBLE_HEIGHT = 130;
const MAX_BUBBLE_HEIGHT = 720;

let currentSourceText = "";
let selectionWatchTimer = null;
let lastAnchorRect = null;
let currentPageRunId = "";
let pageBlockCounter = 0;
let bubbleDragState = null;
let bubbleResizeState = null;
let bubbleSizeSaveTimer = null;
let bubblePinnedByDrag = false;
let bubblePinned = false;
let bubbleEverPlaced = false;
let currentBubbleWidth = DEFAULT_BUBBLE_WIDTH;
let currentBubbleHeight = DEFAULT_BUBBLE_HEIGHT;
const pageBlockState = new Map();
let immersiveModeEnabled = false;
let immersiveSelectionTimer = null;
let immersiveScrollTimer = null;
let immersivePageTranslateInFlight = false;
let immersiveLastSelectionText = "";
let immersiveLastSelectionAt = 0;

function isBubbleElementEvent(event) {
  const host = document.getElementById(MLX_HOST_ID);
  if (!host) return false;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return path.includes(host) || event.target === host || host.contains(event.target);
}

function sendRuntimeMessageBestEffort(message) {
  try {
    const result = api.runtime.sendMessage(message);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch (_) {
  }
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

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clampBubbleWidth(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_BUBBLE_WIDTH;
  return Math.min(MAX_BUBBLE_WIDTH, Math.max(MIN_BUBBLE_WIDTH, num));
}

function clampBubbleHeight(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_BUBBLE_HEIGHT;
  return Math.min(MAX_BUBBLE_HEIGHT, Math.max(MIN_BUBBLE_HEIGHT, num));
}

function getBubbleWidth(margin = 12) {
  return Math.min(clampBubbleWidth(currentBubbleWidth), Math.max(MIN_BUBBLE_WIDTH, window.innerWidth - margin * 2));
}

function getBubbleHeight(margin = 12) {
  if (!currentBubbleHeight) return 0;
  return Math.min(clampBubbleHeight(currentBubbleHeight), Math.max(MIN_BUBBLE_HEIGHT, window.innerHeight - margin * 2));
}

function applyBubbleSize(host) {
  if (!host) return;
  const width = getBubbleWidth(12);
  const height = getBubbleHeight(12);

  host.style.setProperty("width", `${Math.round(width)}px`, "important");
  host.style.setProperty("max-width", "calc(100vw - 24px)", "important");
  host.dataset.mlxViewportWidth = String(Math.round(width));

  if (height > 0) {
    host.style.setProperty("height", `${Math.round(height)}px`, "important");
    host.dataset.mlxViewportHeight = String(Math.round(height));
  } else {
    host.style.removeProperty("height");
    delete host.dataset.mlxViewportHeight;
  }

  const bubble = host.shadowRoot?.querySelector(".bubble");
  if (bubble) {
    bubble.style.setProperty("width", "100%", "important");
    if (height > 0) {
      bubble.style.setProperty("height", "100%", "important");
      bubble.style.setProperty("max-height", "none", "important");
    } else {
      bubble.style.removeProperty("height");
      bubble.style.setProperty("max-height", "min(70vh, 620px)", "important");
    }
  }
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

async function refreshBubbleSize() {
  try {
    const saved = await storageGetLocal({
      bubbleSizeVersion: 0,
      bubbleWidth: DEFAULT_BUBBLE_WIDTH,
      bubbleHeight: DEFAULT_BUBBLE_HEIGHT
    });

    // v1.6 uses window-style manual sizing only. Ignore old slider values
    // unless they were saved by the v1.6 border-resize path. This prevents
    // stale v1.5 settings from forcing the bubble into a very short height.
    if (Number(saved?.bubbleSizeVersion) === 2) {
      currentBubbleWidth = clampBubbleWidth(saved?.bubbleWidth);
      currentBubbleHeight = clampBubbleHeight(saved?.bubbleHeight);
    } else {
      currentBubbleWidth = DEFAULT_BUBBLE_WIDTH;
      currentBubbleHeight = DEFAULT_BUBBLE_HEIGHT;
    }

    const host = document.getElementById(MLX_HOST_ID);
    if (host) {
      applyBubbleSize(host);
      keepPinnedBubbleInPlace(host);
    }
  } catch (_) {
    currentBubbleWidth = DEFAULT_BUBBLE_WIDTH;
    currentBubbleHeight = DEFAULT_BUBBLE_HEIGHT;
  }
}

function getSelectedText() {
  return window.getSelection ? window.getSelection().toString().trim() : "";
}

function getSelectionRect() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  const rect = rects[rects.length - 1] || range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;

  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  };
}

function getOrCreateHost() {
  let host = document.getElementById(MLX_HOST_ID);
  if (host) return host;

  host = document.createElement("div");
  host.id = MLX_HOST_ID;
  host.setAttribute("data-local-mlx", "true");
  host.style.cssText = `
    position: fixed !important;
    z-index: 2147483647 !important;
    left: auto !important;
    top: auto !important;
    right: auto !important;
    bottom: auto !important;
    transform: none !important;
    width: min(560px, calc(100vw - 24px)) !important;
    max-width: calc(100vw - 24px) !important;
    pointer-events: auto !important;
  `;

  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .bubble {
        box-sizing: border-box;
        position: relative;
        max-height: min(70vh, 620px);
        overflow: auto;
        padding: 42px 22px 20px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 16px;
        background: rgba(30, 30, 32, 0.82);
        color: rgba(255, 255, 255, 0.94);
        box-shadow: 0 14px 42px rgba(0, 0, 0, 0.22);
        backdrop-filter: saturate(180%) blur(18px);
        -webkit-backdrop-filter: saturate(180%) blur(18px);
        font: 17px/1.76 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        letter-spacing: 0.01em;
        opacity: 0;
        transform: translateY(4px) scale(0.985);
        animation: mlx-in 120ms ease-out forwards;
        cursor: grab;
      }
      .bubble:active, .bubble.dragging { cursor: grabbing; }
      @media (prefers-color-scheme: light) {
        .bubble {
          border-color: rgba(0, 0, 0, 0.10);
          background: rgba(250, 250, 252, 0.84);
          color: rgba(0, 0, 0, 0.86);
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14);
        }
        .action {
          color: rgba(0, 0, 0, 0.92);
          background: rgba(255, 255, 255, 0.92);
          border-color: rgba(0, 0, 0, 0.16);
        }
        .error { color: #b3261e; }
      }
      @keyframes mlx-in { to { opacity: 1; transform: translateY(0) scale(1); } }
      .topbar {
        position: absolute;
        left: 10px;
        right: 10px;
        top: 8px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 32px;
        user-select: none;
        pointer-events: none;
      }
      .action {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid rgba(0, 0, 0, 0.18);
        border-radius: 999px;
        padding: 0;
        background: rgba(255, 255, 255, 0.96);
        color: rgba(0, 0, 0, 0.94);
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
        cursor: pointer;
        opacity: .92;
        pointer-events: auto;
        transition: opacity 120ms ease, background 120ms ease, transform 120ms ease, box-shadow 120ms ease;
      }
      .action svg {
        width: 18px;
        height: 18px;
        display: block;
        stroke: currentColor;
      }
      .bubble:hover .action, .bubble.pinned .action { opacity: 1; }
      .action:hover { background: rgba(255, 255, 255, 1); transform: translateY(-0.5px); box-shadow: 0 3px 10px rgba(0, 0, 0, 0.22); }
      .pin[aria-pressed="true"] { background: rgba(255, 214, 10, 0.98); color: rgba(0, 0, 0, 0.94); border-color: rgba(0, 0, 0, 0.18); }
      .copy .check-icon { display: none; }
      .copy.copied .copy-icon { display: none; }
      .copy.copied .check-icon { display: block; }
      .bubble.dragging, .bubble.resizing { user-select: none; }
      .bubble.edge-resize {
        box-shadow: 0 14px 42px rgba(0, 0, 0, 0.24), inset 0 0 0 1px rgba(10, 132, 255, 0.20);
      }
      .body {
        white-space: pre-wrap;
        word-break: break-word;
        padding-right: 4px;
        cursor: inherit;
      }
      .loading {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        opacity: 0.78;
        white-space: nowrap;
      }
      .dot {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.62;
        animation: pulse 780ms ease-in-out infinite alternate;
      }
      @keyframes pulse { from { transform: scale(0.72); opacity: 0.38; } to { transform: scale(1); opacity: 0.78; } }
      .error { color: #ffb4ab; }
    </style>
    <div class="bubble" part="bubble">
      <div class="topbar">
        <button class="action pin" title="固定翻译框" aria-label="固定翻译框" aria-pressed="false">
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14.5 3.5l6 6" stroke-width="2" stroke-linecap="round"/>
            <path d="M8.6 10.1l5.3-5.3 5.3 5.3-5.3 5.3" stroke-width="2" stroke-linejoin="round"/>
            <path d="M11.4 12.6L5 19" stroke-width="2" stroke-linecap="round"/>
            <path d="M4.5 19.5l3.8-1.1" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
        <button class="action copy" title="复制译文" aria-label="复制译文">
          <svg class="copy-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="8" y="8" width="10" height="12" rx="2" stroke-width="2"/>
            <path d="M6 16H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <svg class="check-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12.5l4.2 4.2L19 7" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="body"></div>
    </div>
  `;
  applyBubbleSize(host);

  root.querySelector(".copy").addEventListener("click", async (event) => {
    const bodyText = root.querySelector(".body")?.textContent?.trim();
    if (!bodyText || bodyText === "正在翻译") return;
    await navigator.clipboard.writeText(bodyText).catch(() => {});
    const button = root.querySelector(".copy");
    button.classList.add("copied");
    button.title = "已复制";
    button.setAttribute("aria-label", "已复制");
    setTimeout(() => {
      button.classList.remove("copied");
      button.title = "复制译文";
      button.setAttribute("aria-label", "复制译文");
    }, 900);
    event.preventDefault();
    event.stopPropagation();
  });

  const pinButton = root.querySelector(".pin");
  pinButton.addEventListener("mousedown", (event) => {
    // Toggle on mousedown instead of click. In Safari, clicking a page overlay can
    // collapse the current selection before the click handler runs; pinning here
    // makes the bubble independent from selectionchange as early as possible.
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

    const host = document.getElementById(MLX_HOST_ID);
    if (!isBubblePinned()) {
      freezeBubblePosition(host);
      bubblePinnedByDrag = true;
      setBubblePinned(true);
    } else {
      // Requirement: leaving pinned mode closes the bubble immediately.
      removeTranslationBubble({ force: true });
    }
  }, true);

  pinButton.addEventListener("click", (event) => {
    // The actual state transition happens on mousedown. Keep click inert so a
    // delayed click cannot toggle pin twice.
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
  }, true);

  const bubble = root.querySelector(".bubble");
  bubble.addEventListener("mousemove", updateBubbleCursor);
  bubble.addEventListener("mouseleave", resetBubbleCursor);
  bubble.addEventListener("mousedown", startBubblePointer, true);

  document.documentElement.appendChild(host);
  return host;
}

function updateBubblePinState() {
  const host = document.getElementById(MLX_HOST_ID);
  const bubble = host?.shadowRoot?.querySelector(".bubble");
  const pin = host?.shadowRoot?.querySelector(".pin");
  if (!bubble || !pin) return;

  const pinned = isBubblePinned();
  bubble.classList.toggle("pinned", pinned);
  pin.setAttribute("aria-pressed", pinned ? "true" : "false");
  pin.title = pinned ? "取消固定" : "固定翻译框";
  pin.setAttribute("aria-label", pinned ? "取消固定" : "固定翻译框");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isBubblePinned() {
  const host = document.getElementById(MLX_HOST_ID);
  return bubblePinned || host?.dataset?.mlxPinned === "true";
}

function setBubblePinned(nextPinned) {
  bubblePinned = Boolean(nextPinned);
  const host = document.getElementById(MLX_HOST_ID);
  if (host) host.dataset.mlxPinned = bubblePinned ? "true" : "false";
  if (bubblePinned) {
    clearTimeout(selectionWatchTimer);
    selectionWatchTimer = null;
  }
  updateBubblePinState();
}

function setHostViewportPosition(host, left, top, width = null, height = null) {
  if (!host) return;
  host.style.setProperty("position", "fixed", "important");
  host.style.setProperty("left", `${Math.round(left)}px`, "important");
  host.style.setProperty("top", `${Math.round(top)}px`, "important");
  host.style.setProperty("right", "auto", "important");
  host.style.setProperty("bottom", "auto", "important");
  host.style.setProperty("transform", "none", "important");
  host.dataset.mlxViewportLeft = String(Math.round(left));
  host.dataset.mlxViewportTop = String(Math.round(top));
  bubbleEverPlaced = true;
  if (width !== null) {
    const roundedWidth = Math.round(width);
    host.style.setProperty("width", `${roundedWidth}px`, "important");
    host.dataset.mlxViewportWidth = String(roundedWidth);
  }
  if (height !== null && height > 0) {
    const roundedHeight = Math.round(height);
    host.style.setProperty("height", `${roundedHeight}px`, "important");
    host.dataset.mlxViewportHeight = String(roundedHeight);
  }
}

function keepPinnedBubbleInPlace(host) {
  if (!host) return;
  const margin = 8;
  const rect = host.getBoundingClientRect();
  const width = clamp(rect.width || getBubbleWidth(margin), MIN_BUBBLE_WIDTH, Math.max(MIN_BUBBLE_WIDTH, window.innerWidth - margin * 2));
  const height = rect.height || getBubbleHeight(margin) || 0;
  const storedLeft = Number(host.dataset.mlxViewportLeft);
  const storedTop = Number(host.dataset.mlxViewportTop);
  const left = clamp(Number.isFinite(storedLeft) ? storedLeft : rect.left, margin, Math.max(margin, window.innerWidth - width - margin));
  const topMax = height > 0 ? Math.max(margin, window.innerHeight - height - margin) : Math.max(margin, window.innerHeight - 80);
  const top = clamp(Number.isFinite(storedTop) ? storedTop : rect.top, margin, topMax);
  setHostViewportPosition(host, left, top, width, height > 0 ? height : null);
}

function freezeBubblePosition(host) {
  if (!host) return;
  const rect = host.getBoundingClientRect();
  const margin = 8;
  const width = clamp(rect.width || getBubbleWidth(margin), MIN_BUBBLE_WIDTH, Math.max(MIN_BUBBLE_WIDTH, window.innerWidth - margin * 2));
  const height = rect.height || 0;
  const left = clamp(rect.left, margin, Math.max(margin, window.innerWidth - width - margin));
  const top = clamp(rect.top, margin, Math.max(margin, window.innerHeight - Math.max(height, 80) - margin));
  setHostViewportPosition(host, left, top, width, height > 0 ? height : null);
}

function getResizeModeFromEvent(event, bubble) {
  if (!bubble) return "";
  if (event.target?.closest?.("button, a, input, textarea, select")) return "";

  const rect = bubble.getBoundingClientRect();
  const edge = 14;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const nearLeft = x >= 0 && x <= edge;
  const nearRight = x <= rect.width && x >= rect.width - edge;
  const nearTop = y >= 0 && y <= edge;
  const nearBottom = y <= rect.height && y >= rect.height - edge;

  if (nearTop && nearLeft) return "nw";
  if (nearTop && nearRight) return "ne";
  if (nearBottom && nearLeft) return "sw";
  if (nearBottom && nearRight) return "se";
  if (nearTop) return "n";
  if (nearBottom) return "s";
  if (nearLeft) return "w";
  if (nearRight) return "e";
  return "";
}

function cursorForResizeMode(mode) {
  if (mode === "n" || mode === "s") return "ns-resize";
  if (mode === "e" || mode === "w") return "ew-resize";
  if (mode === "ne" || mode === "sw") return "nesw-resize";
  if (mode === "nw" || mode === "se") return "nwse-resize";
  return "grab";
}

function updateBubbleCursor(event) {
  if (bubbleDragState || bubbleResizeState) return;
  const bubble = event.currentTarget;
  const mode = getResizeModeFromEvent(event, bubble);
  bubble.style.cursor = cursorForResizeMode(mode);
  bubble.classList.toggle("edge-resize", Boolean(mode));
}

function resetBubbleCursor(event) {
  if (bubbleDragState || bubbleResizeState) return;
  const bubble = event.currentTarget;
  bubble.style.cursor = "grab";
  bubble.classList.remove("edge-resize");
}

function startBubblePointer(event) {
  if (event.button !== 0) return;
  const bubble = event.currentTarget;
  const mode = getResizeModeFromEvent(event, bubble);
  if (mode) {
    startBubbleResize(event, mode);
    return;
  }
  startBubbleDrag(event);
}

function scheduleBubbleSizeSave() {
  clearTimeout(bubbleSizeSaveTimer);
  bubbleSizeSaveTimer = setTimeout(() => {
    storageSetLocal({
      bubbleSizeVersion: 2,
      bubbleWidth: Math.round(currentBubbleWidth),
      bubbleHeight: Math.round(currentBubbleHeight)
    }).catch(() => {});
  }, 120);
}

function startBubbleResize(event, mode) {
  if (event.button !== 0) return;
  const host = document.getElementById(MLX_HOST_ID);
  const bubble = host?.shadowRoot?.querySelector(".bubble");
  mode = mode || getResizeModeFromEvent(event, bubble) || "se";
  if (!host || !bubble) return;

  freezeBubblePosition(host);
  const rect = host.getBoundingClientRect();
  bubblePinnedByDrag = true;
  bubble.classList.add("resizing");

  bubbleResizeState = {
    mode,
    startX: event.clientX,
    startY: event.clientY,
    startLeft: rect.left,
    startTop: rect.top,
    startWidth: rect.width,
    startHeight: rect.height,
    startRight: rect.right,
    startBottom: rect.bottom
  };

  document.addEventListener("mousemove", moveBubbleResize, true);
  document.addEventListener("mouseup", stopBubbleResize, true);
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
}

function moveBubbleResize(event) {
  const host = document.getElementById(MLX_HOST_ID);
  if (!host || !bubbleResizeState) return;

  const state = bubbleResizeState;
  const margin = 8;
  const dx = event.clientX - state.startX;
  const dy = event.clientY - state.startY;
  let left = state.startLeft;
  let top = state.startTop;
  let width = state.startWidth;
  let height = state.startHeight;

  if (state.mode.includes("e")) {
    width = clamp(state.startWidth + dx, MIN_BUBBLE_WIDTH, Math.max(MIN_BUBBLE_WIDTH, window.innerWidth - state.startLeft - margin));
  }
  if (state.mode.includes("w")) {
    width = clamp(state.startWidth - dx, MIN_BUBBLE_WIDTH, Math.max(MIN_BUBBLE_WIDTH, state.startRight - margin));
    left = state.startRight - width;
  }
  if (state.mode.includes("s")) {
    height = clamp(state.startHeight + dy, MIN_BUBBLE_HEIGHT, Math.max(MIN_BUBBLE_HEIGHT, window.innerHeight - state.startTop - margin));
  }
  if (state.mode.includes("n")) {
    height = clamp(state.startHeight - dy, MIN_BUBBLE_HEIGHT, Math.max(MIN_BUBBLE_HEIGHT, state.startBottom - margin));
    top = state.startBottom - height;
  }

  left = clamp(left, margin, Math.max(margin, window.innerWidth - width - margin));
  top = clamp(top, margin, Math.max(margin, window.innerHeight - height - margin));
  currentBubbleWidth = clampBubbleWidth(width);
  currentBubbleHeight = clampBubbleHeight(height);

  setHostViewportPosition(host, left, top, currentBubbleWidth, currentBubbleHeight);
  applyBubbleSize(host);
  scheduleBubbleSizeSave();
  event.preventDefault();
}

function stopBubbleResize() {
  document.removeEventListener("mousemove", moveBubbleResize, true);
  document.removeEventListener("mouseup", stopBubbleResize, true);
  document.getElementById(MLX_HOST_ID)?.shadowRoot?.querySelector(".bubble")?.classList.remove("resizing");
  if (bubbleResizeState) {
    storageSetLocal({
      bubbleSizeVersion: 2,
      bubbleWidth: Math.round(currentBubbleWidth),
      bubbleHeight: Math.round(currentBubbleHeight)
    }).catch(() => {});
  }
  bubbleResizeState = null;
}

function startBubbleDrag(event) {
  if (event.button !== 0) return;
  if (event.target?.closest?.("button, a, input, textarea, select")) return;

  const host = document.getElementById(MLX_HOST_ID);
  if (!host) return;

  const rect = host.getBoundingClientRect();
  bubbleDragState = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };
  bubblePinnedByDrag = true;
  host.shadowRoot?.querySelector(".bubble")?.classList.add("dragging");

  document.addEventListener("mousemove", moveBubbleDrag, true);
  document.addEventListener("mouseup", stopBubbleDrag, true);
  event.preventDefault();
  event.stopPropagation();
  if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
}

function moveBubbleDrag(event) {
  const host = document.getElementById(MLX_HOST_ID);
  if (!host || !bubbleDragState) return;

  const rect = host.getBoundingClientRect();
  const margin = 8;
  const left = clamp(event.clientX - bubbleDragState.offsetX, margin, window.innerWidth - rect.width - margin);
  const top = clamp(event.clientY - bubbleDragState.offsetY, margin, window.innerHeight - rect.height - margin);

  setHostViewportPosition(host, left, top);
  event.preventDefault();
}

function stopBubbleDrag() {
  document.getElementById(MLX_HOST_ID)?.shadowRoot?.querySelector(".bubble")?.classList.remove("dragging");
  bubbleDragState = null;
  document.removeEventListener("mousemove", moveBubbleDrag, true);
  document.removeEventListener("mouseup", stopBubbleDrag, true);
}

function removeTranslationBubble(options = {}) {
  const force = options.force === true;
  if (!force && isBubblePinned()) return;

  clearTimeout(selectionWatchTimer);
  selectionWatchTimer = null;
  document.getElementById(MLX_HOST_ID)?.remove();
  currentSourceText = "";
  lastAnchorRect = null;
  bubblePinnedByDrag = false;
  bubblePinned = false;
  bubbleDragState = null;
  bubbleResizeState = null;
  bubbleEverPlaced = false;
}

function placeHost(host, anchorRect = null) {
  if (!host || isBubblePinned()) return;

  const rect = anchorRect || getSelectionRect() || lastAnchorRect;
  const margin = 12;
  const width = getBubbleWidth(margin);

  let left;
  let top;

  if (rect) {
    left = Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin);
    top = rect.bottom + 8;

    const estimatedHeight = Math.min(300, window.innerHeight * 0.48);
    if (top + estimatedHeight > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - estimatedHeight - 8);
    }
  } else {
    left = window.innerWidth - width - 18;
    top = window.innerHeight - 120;
  }

  setHostViewportPosition(host, left, top, width);
}

function renderBubble(payload = {}) {
  const host = getOrCreateHost();
  const root = host.shadowRoot;
  const body = root.querySelector(".body");
  const copy = root.querySelector(".copy");
  const pin = root.querySelector(".pin");
  if (pin) pin.style.display = "";
  updateBubblePinState();

  if (payload.loading) {
    body.classList.remove("error");
    body.innerHTML = `<span class="loading"><span class="dot"></span><span>正在翻译</span></span>`;
    copy.style.display = "none";
  } else if (payload.error) {
    body.textContent = payload.error;
    body.classList.add("error");
    copy.style.display = "none";
  } else {
    body.classList.remove("error");
    body.textContent = payload.translation || "没有翻译结果。";
    copy.style.display = "";
  }

  const anchor = getSelectionRect() || lastAnchorRect;
  if (anchor) lastAnchorRect = anchor;

  // Position only when a new translation starts or the bubble has no saved viewport position.
  // After that, keep the bubble visually stable while the page scrolls.
  if (!isBubblePinned() && !bubblePinnedByDrag && (payload.loading || !bubbleEverPlaced)) {
    placeHost(host, anchor);
  }
}

function shouldIgnorePayload(payload = {}) {
  if (!payload.source) return false;
  const selected = normalizeText(getSelectedText());
  const source = normalizeText(payload.source);
  if (isBubblePinned() && currentSourceText && source === currentSourceText) return false;
  if (!selected) return true;
  return selected !== source;
}

function showTranslationBox(payload = {}) {
  if (!payload.loading && shouldIgnorePayload(payload)) return;

  if (payload.source) {
    const nextSourceText = normalizeText(payload.source);
    if (nextSourceText && nextSourceText !== currentSourceText && !isBubblePinned()) {
      bubblePinnedByDrag = false;
      bubbleEverPlaced = false;
    }
    currentSourceText = nextSourceText;
  }
  const anchor = getSelectionRect();
  if (anchor) lastAnchorRect = anchor;
  renderBubble(payload);
}

function scheduleSelectionCheck() {
  // Default mode follows the browser selection lifecycle; pinned mode does not.
  // If the bubble is pinned, selectionchange must be a complete no-op.
  if (isBubblePinned()) return;

  clearTimeout(selectionWatchTimer);
  selectionWatchTimer = setTimeout(() => {
    const host = document.getElementById(MLX_HOST_ID);
    if (!host) return;

    // Pinned bubbles must survive Safari clearing the selection after the user
    // clicks elsewhere on the page. In pinned mode, selection state is ignored.
    if (isBubblePinned()) return;

    const selected = normalizeText(getSelectedText());
    if (selected && currentSourceText && selected !== currentSourceText) {
      removeTranslationBubble();
      return;
    }

    if (!selected) {
      removeTranslationBubble();
      return;
    }

    // Do not reposition here. The bubble should stay where it first appeared
    // until the user drags it or starts another translation.
  }, 110);
}

function isElementVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 24 || rect.height < 8) return false;
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight + 2400;
}

function hasMostlyTranslatableText(text) {
  const clean = normalizeText(text);
  if (clean.length < 18) return false;
  if (clean.length > 1800) return false;
  const letters = clean.match(/[A-Za-z]/g)?.length || 0;
  return letters >= 8 && letters / clean.length > 0.18;
}

function isBadContainer(el) {
  return Boolean(el.closest([
    "script",
    "style",
    "noscript",
    "svg",
    "canvas",
    "video",
    "audio",
    "textarea",
    "input",
    "select",
    "button",
    "pre",
    "code",
    "nav",
    "footer",
    "aside",
    "[contenteditable='true']",
    `#${MLX_HOST_ID}`,
    `[${MLX_PAGE_TRANSLATION_ATTR}]`
  ].join(",")));
}

function makeElementPath(el) {
  const parts = [];
  let node = el;
  let depth = 0;
  while (node && depth < 6 && node.nodeType === 1) {
    const tag = (node.tagName || "").toLowerCase();
    if (!tag) break;
    let index = 1;
    let prev = node.previousElementSibling;
    while (prev) {
      if (prev.tagName === node.tagName) index += 1;
      prev = prev.previousElementSibling;
    }
    parts.unshift(`${tag}:${index}`);
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(">");
}

function getPageRoot() {
  return document.querySelector("main article") ||
    document.querySelector("article") ||
    document.querySelector("main") ||
    document.body;
}

function ensurePageStyle() {
  if (document.getElementById(MLX_PAGE_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = MLX_PAGE_STYLE_ID;
  style.textContent = `
    [${MLX_PAGE_TRANSLATION_ATTR}] {
      box-sizing: border-box !important;
      margin: 0.35em 0 0.9em !important;
      padding: 0.42em 0.58em !important;
      border-left: 2px solid rgba(10, 132, 255, 0.45) !important;
      border-radius: 8px !important;
      background: rgba(10, 132, 255, 0.065) !important;
      color: inherit !important;
      font: 0.95em/1.62 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif !important;
      opacity: 0.88 !important;
      white-space: pre-wrap !important;
      word-break: break-word !important;
    }
    [${MLX_PAGE_TRANSLATION_ATTR}] .mlx-trx-body {
      white-space: pre-wrap !important;
      word-break: break-word !important;
    }
    [${MLX_PAGE_TRANSLATION_ATTR}][data-status="error"] {
      border-left-color: rgba(255, 59, 48, 0.56) !important;
      background: rgba(255, 59, 48, 0.08) !important;
    }
    [${MLX_PAGE_TRANSLATION_ATTR}].mlx-trx-linked,
    [${MLX_PAGE_BLOCK_ATTR}].mlx-src-linked {
      outline: 2px solid rgba(10, 132, 255, 0.23) !important;
      outline-offset: 2px !important;
      border-radius: 7px !important;
    }
    li > [${MLX_PAGE_TRANSLATION_ATTR}], td > [${MLX_PAGE_TRANSLATION_ATTR}], th > [${MLX_PAGE_TRANSLATION_ATTR}] {
      margin: 0.35em 0 0.15em !important;
    }
  `;
  document.documentElement.appendChild(style);
}

function clearPageTranslations() {
  document.querySelectorAll(`[${MLX_PAGE_TRANSLATION_ATTR}]`).forEach((el) => el.remove());
  document.querySelectorAll(`[${MLX_PAGE_BLOCK_ATTR}]`).forEach((el) => el.removeAttribute(MLX_PAGE_BLOCK_ATTR));
  pageBlockState.clear();
}

function getOrCreateImmersiveDot() {
  let dot = document.getElementById(MLX_IMMERSIVE_DOT_ID);
  if (dot) return dot;
  dot = document.createElement("button");
  dot.id = MLX_IMMERSIVE_DOT_ID;
  dot.type = "button";
  dot.style.cssText = `
    position: fixed !important;
    right: 14px !important;
    bottom: 14px !important;
    z-index: 2147483647 !important;
    border: 0 !important;
    border-radius: 999px !important;
    padding: 5px 9px !important;
    font: 11px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif !important;
    background: rgba(10, 132, 255, 0.92) !important;
    color: #fff !important;
    box-shadow: 0 6px 18px rgba(0,0,0,0.22) !important;
    cursor: pointer !important;
    opacity: 0.9 !important;
  `;
  dot.addEventListener("click", () => {
    if (!immersiveModeEnabled) return;
    setImmersiveModeEnabled(false).catch(() => {});
    storageSetLocal({ immersiveModeEnabled: false }).catch(() => {});
    sendRuntimeMessageBestEffort({ type: "IMMERSIVE_MODE_CHANGED", enabled: false });
  });
  document.documentElement.appendChild(dot);
  return dot;
}

function removeImmersiveDot() {
  document.getElementById(MLX_IMMERSIVE_DOT_ID)?.remove();
}

function updateImmersiveDot() {
  if (!immersiveModeEnabled) {
    removeImmersiveDot();
    return;
  }
  const dot = getOrCreateImmersiveDot();
  dot.style.display = "";
  dot.textContent = "沉浸 ON";
  dot.title = "点击关闭沉浸式阅读";
  dot.style.background = "rgba(10, 132, 255, 0.92)";
}

function isElementNearViewport(el, margin = 560) {
  const rect = el.getBoundingClientRect();
  return rect.bottom >= -margin && rect.top <= window.innerHeight + margin;
}

function collectImmersiveBlocks(limit = 20) {
  ensurePageStyle();
  const root = getPageRoot();
  if (!root) return [];
  const selector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th";
  const blocks = [];
  const candidates = Array.from(root.querySelectorAll(selector));

  for (const el of candidates) {
    if (blocks.length >= limit) break;
    if (isBadContainer(el) || !isElementVisible(el) || !isElementNearViewport(el)) continue;
    const rawText = normalizeText(el.innerText || el.textContent || "");
    if (!hasMostlyTranslatableText(rawText)) continue;

    let id = el.getAttribute(MLX_PAGE_BLOCK_ATTR);
    if (!id) {
      id = `${currentPageRunId || "immersive"}-${++pageBlockCounter}`;
      el.setAttribute(MLX_PAGE_BLOCK_ATTR, id);
      el.addEventListener("mouseenter", () => {
        document.querySelector(`[${MLX_PAGE_TRANSLATION_ATTR}][data-block-id="${CSS.escape(id)}"]`)?.classList.add("mlx-trx-linked");
        el.classList.add("mlx-src-linked");
      });
      el.addEventListener("mouseleave", () => {
        document.querySelector(`[${MLX_PAGE_TRANSLATION_ATTR}][data-block-id="${CSS.escape(id)}"]`)?.classList.remove("mlx-trx-linked");
        el.classList.remove("mlx-src-linked");
      });
    }

    const state = pageBlockState.get(id) || {};
    if (state.status === "done" || state.status === "running") continue;
    pageBlockState.set(id, { ...state, text: rawText, status: "pending" });
    blocks.push({ id, text: rawText });
  }

  return blocks;
}

async function scheduleImmersiveViewportTranslate(delay = 220) {
  if (!immersiveModeEnabled) return;
  clearTimeout(immersiveScrollTimer);
  immersiveScrollTimer = setTimeout(async () => {
    if (!immersiveModeEnabled || immersivePageTranslateInFlight) return;
    const blocks = collectImmersiveBlocks(18);
    if (!blocks.length) return;
    immersivePageTranslateInFlight = true;
    for (const block of blocks) {
      const prev = pageBlockState.get(block.id) || {};
      pageBlockState.set(block.id, { ...prev, text: block.text, status: "running" });
    }
    try {
      const response = await sendRuntimeMessage({ type: "TRANSLATE_PAGE_BLOCKS", blocks });
      if (response?.ok) {
        for (const item of response.translations || []) {
          if (item?.text) insertPageTranslation(item.id, item.text);
          else insertPageTranslationError(item.id, "翻译失败");
        }
      }
    } catch (_) {
      for (const block of blocks) insertPageTranslationError(block.id, "翻译失败");
    } finally {
      immersivePageTranslateInFlight = false;
    }
  }, delay);
}

function scheduleImmersiveSelectionTranslate() {
  if (!immersiveModeEnabled) return;
  clearTimeout(immersiveSelectionTimer);
  immersiveSelectionTimer = setTimeout(async () => {
    if (!immersiveModeEnabled) return;
    const text = normalizeText(getSelectedText());
    if (!text || text.length < 6) return;
    if (text === immersiveLastSelectionText) return;
    const now = Date.now();
    if (now - immersiveLastSelectionAt < 1200) return;
    immersiveLastSelectionText = text;
    immersiveLastSelectionAt = now;
    await sendRuntimeMessage({ type: "AUTO_TRANSLATE_SELECTION", text }).catch(() => {});
  }, 380);
}

async function setImmersiveModeEnabled(nextEnabled) {
  immersiveModeEnabled = Boolean(nextEnabled);
  if (!immersiveModeEnabled) {
    clearTimeout(immersiveSelectionTimer);
    clearTimeout(immersiveScrollTimer);
    immersiveSelectionTimer = null;
    immersiveScrollTimer = null;
    immersivePageTranslateInFlight = false;
    immersiveLastSelectionText = "";
    immersiveLastSelectionAt = 0;
    sendRuntimeMessageBestEffort({ type: "CANCEL_PAGE_TRANSLATION" });
    restorePageTranslations();
  } else {
    currentPageRunId = currentPageRunId || `immersive-${Date.now()}`;
    scheduleImmersiveViewportTranslate(80);
  }
  updateImmersiveDot();
}

async function loadImmersiveModeFromStorage() {
  try {
    const saved = await storageGetLocal({ immersiveModeEnabled: false });
    await setImmersiveModeEnabled(Boolean(saved?.immersiveModeEnabled));
  } catch (_) {
    await setImmersiveModeEnabled(false);
  }
}

function collectPageBlocks(runId) {
  clearPageTranslations();
  ensurePageStyle();

  const root = getPageRoot();
  if (!root) return [];

  const selector = "h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th";
  const candidates = Array.from(root.querySelectorAll(selector));
  const blocks = [];
  const seen = new Set();

  for (const el of candidates) {
    if (blocks.length >= 96) break;
    if (isBadContainer(el) || !isElementVisible(el)) continue;

    const rawText = normalizeText(el.innerText || el.textContent || "");
    if (!hasMostlyTranslatableText(rawText)) continue;

    const signature = `${makeElementPath(el)}|${rawText.length}|${rawText.slice(0, 220)}`;
    if (seen.has(signature)) continue;
    seen.add(signature);

    const id = `${runId || "page"}-${++pageBlockCounter}`;
    el.setAttribute(MLX_PAGE_BLOCK_ATTR, id);
    el.addEventListener("mouseenter", () => {
      document.querySelector(`[${MLX_PAGE_TRANSLATION_ATTR}][data-block-id="${CSS.escape(id)}"]`)?.classList.add("mlx-trx-linked");
      el.classList.add("mlx-src-linked");
    });
    el.addEventListener("mouseleave", () => {
      document.querySelector(`[${MLX_PAGE_TRANSLATION_ATTR}][data-block-id="${CSS.escape(id)}"]`)?.classList.remove("mlx-trx-linked");
      el.classList.remove("mlx-src-linked");
    });
    pageBlockState.set(id, { text: rawText, status: "pending" });
    blocks.push({ id, text: rawText });
  }

  currentPageRunId = runId || "";
  return blocks;
}

function createTranslationNode(id, text, options = {}) {
  const status = options.status || "done";
  const message = options.message || "";
  const bodyText = String(text || "").trim();
  const node = document.createElement("div");
  node.setAttribute(MLX_PAGE_TRANSLATION_ATTR, "true");
  node.dataset.blockId = id || "";
  node.dataset.status = status;
  node.innerHTML = `<div class="mlx-trx-body"></div>`;
  const body = node.querySelector(".mlx-trx-body");
  body.textContent = status === "error" ? message : bodyText;
  node.addEventListener("mouseenter", () => {
    const blockId = node.dataset.blockId;
    if (!blockId) return;
    document.querySelector(`[${MLX_PAGE_BLOCK_ATTR}="${CSS.escape(blockId)}"]`)?.classList.add("mlx-src-linked");
    node.classList.add("mlx-trx-linked");
  });
  node.addEventListener("mouseleave", () => {
    const blockId = node.dataset.blockId;
    if (!blockId) return;
    document.querySelector(`[${MLX_PAGE_BLOCK_ATTR}="${CSS.escape(blockId)}"]`)?.classList.remove("mlx-src-linked");
    node.classList.remove("mlx-trx-linked");
  });

  return node;
}

function insertPageTranslation(id, text) {
  const translatedText = String(text || "").trim();
  if (!id || !translatedText) return;

  const target = document.querySelector(`[${MLX_PAGE_BLOCK_ATTR}="${CSS.escape(id)}"]`);
  if (!target || isBadContainer(target)) return;

  const existing = target.querySelector(`:scope > [${MLX_PAGE_TRANSLATION_ATTR}]`);
  if (existing) existing.remove();

  const node = createTranslationNode(id, translatedText, { status: "done" });
  const tag = target.tagName.toLowerCase();
  pageBlockState.set(id, { ...(pageBlockState.get(id) || {}), status: "done", translation: translatedText });

  if (tag === "li" || tag === "td" || tag === "th") {
    target.appendChild(node);
  } else {
    target.insertAdjacentElement("afterend", node);
  }
}

function insertPageTranslationError(id, message) {
  if (!id) return;
  const target = document.querySelector(`[${MLX_PAGE_BLOCK_ATTR}="${CSS.escape(id)}"]`);
  if (!target || isBadContainer(target)) return;
  const existing = target.querySelector(`:scope > [${MLX_PAGE_TRANSLATION_ATTR}]`);
  if (existing) existing.remove();
  const node = createTranslationNode(id, "", { status: "error", message: message || "翻译失败" });
  const tag = target.tagName.toLowerCase();
  pageBlockState.set(id, { ...(pageBlockState.get(id) || {}), status: "error", error: message || "翻译失败" });
  if (tag === "li" || tag === "td" || tag === "th") target.appendChild(node);
  else target.insertAdjacentElement("afterend", node);
}

function restorePageTranslations() {
  currentPageRunId = "";
  clearPageTranslations();
}

function updatePagePanel(payload = {}) {
  if (payload.runId) currentPageRunId = payload.runId;
}

function applyPageTranslationBatch(payload = {}) {
  if (payload.runId && currentPageRunId && payload.runId !== currentPageRunId) return;
  for (const item of payload.translations || []) {
    insertPageTranslation(item.id, item.text);
  }
  updatePagePanel({
    runId: payload.runId,
    status: "running",
    done: payload.done,
    total: payload.total,
    message: `正在翻译 ${payload.done || 0}/${payload.total || 0}`
  });
}

refreshBubbleSize();
loadImmersiveModeFromStorage();

if (api.storage?.onChanged) {
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.immersiveModeEnabled) {
      loadImmersiveModeFromStorage().catch(() => {});
    }
    if (changes.bubbleSizeVersion && Number(changes.bubbleSizeVersion.newValue) !== 2) return;
    if (changes.bubbleWidth) currentBubbleWidth = clampBubbleWidth(changes.bubbleWidth.newValue);
    if (changes.bubbleHeight) currentBubbleHeight = clampBubbleHeight(changes.bubbleHeight.newValue);
    if (!changes.bubbleWidth && !changes.bubbleHeight) return;
    const host = document.getElementById(MLX_HOST_ID);
    if (host) {
      applyBubbleSize(host);
      keepPinnedBubbleInPlace(host);
    }
  });
}

document.addEventListener("selectionchange", scheduleSelectionCheck, true);
document.addEventListener("selectionchange", scheduleImmersiveSelectionTranslate, true);

// Never reposition the translation bubble during page scroll. A fixed overlay
// should stay where it first appeared or where the user dragged it.
document.addEventListener("scroll", () => {
  scheduleImmersiveViewportTranslate(280);
}, true);

window.addEventListener("resize", () => {
  const host = document.getElementById(MLX_HOST_ID);
  if (!host) return;
  // Clamp current coordinates into view only; never recompute from selection.
  keepPinnedBubbleInPlace(host);
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") removeTranslationBubble({ force: true });
}, true);
document.addEventListener("mousedown", (event) => {
  const host = document.getElementById(MLX_HOST_ID);
  if (!host) return;
  if (isBubbleElementEvent(event)) return;

  // In pinned mode, clicking elsewhere may clear Safari selection, but must not
  // close the translation bubble.
  if (isBubblePinned()) return;

  setTimeout(() => {
    if (isBubblePinned()) return;
    const selected = normalizeText(getSelectedText());
    if (!selected || (currentSourceText && selected !== currentSourceText)) removeTranslationBubble();
    else scheduleSelectionCheck();
  }, 0);
}, true);

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "PING") {
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "GET_SELECTION") {
    sendResponse({ text: getSelectedText() });
    return true;
  }

  if (message?.type === "SHOW_TRANSLATION") {
    refreshBubbleSize()
      .then(() => {
        showTranslationBox(message);
        sendResponse({ ok: true });
      })
      .catch(() => {
        showTranslationBox(message);
        sendResponse({ ok: true });
      });
    return true;
  }

  if (message?.type === "SET_BUBBLE_SIZE") {
    currentBubbleWidth = clampBubbleWidth(message.width);
    currentBubbleHeight = clampBubbleHeight(message.height);
    const host = document.getElementById(MLX_HOST_ID);
    if (host) {
      applyBubbleSize(host);
      keepPinnedBubbleInPlace(host);
    }
    sendResponse({ ok: true, bubbleWidth: currentBubbleWidth, bubbleHeight: currentBubbleHeight });
    return true;
  }

  if (message?.type === "GET_PAGE_BLOCKS") {
    const blocks = collectPageBlocks(message.runId || "");
    updatePagePanel({ runId: message.runId, status: "running", done: 0, total: blocks.length });
    sendResponse({ blocks });
    return true;
  }

  if (message?.type === "PAGE_TRANSLATION_STATUS") {
    updatePagePanel(message);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "PAGE_TRANSLATION_BATCH") {
    applyPageTranslationBatch(message);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "PAGE_TRANSLATION_DONE") {
    updatePagePanel({ ...message, status: "done" });
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "RESTORE_PAGE_TRANSLATION") {
    restorePageTranslations();
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "IMMERSIVE_MODE_CHANGED") {
    setImmersiveModeEnabled(Boolean(message.enabled))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  return false;
});
