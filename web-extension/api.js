const DEFAULT_PROFILE_ID = "microsoft-free-default";
const LEGACY_LOCAL_PROFILE_ID = "local-mlx-default";

const DEFAULT_BUBBLE_SCALE = 1; // Legacy setting from v1.2-v1.4.
const MIN_BUBBLE_SCALE = 0.8;
const MAX_BUBBLE_SCALE = 1.6;
const DEFAULT_BUBBLE_WIDTH = 560;
const DEFAULT_BUBBLE_HEIGHT = 0; // 0 means auto height until manually resized.
const MIN_BUBBLE_WIDTH = 280;
const MAX_BUBBLE_WIDTH = 860;
const MIN_BUBBLE_HEIGHT = 130;
const MAX_BUBBLE_HEIGHT = 720;

const DEFAULT_PROMPT_TEMPLATE = "请将以下文本翻译为自然、准确、流畅的简体中文，符合中文网页、应用界面和技术文档的表达习惯。保留原文中的代码、链接、HTML 标签、Markdown 格式、数字和专有名词。只输出译文，不要解释：\n\n{{text}}";

const DEFAULT_MICROSOFT_PROFILE = Object.freeze({
  id: DEFAULT_PROFILE_ID,
  provider: "microsoft-free",
  name: "微软免费翻译",
  targetLanguage: "zh-Hans",
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: 0.2,
  topP: 0.6,
  maxTokens: 1024,
  promptTemplate: "",
  builtIn: true
});

const EMPTY_OPENAI_PROFILE = Object.freeze({
  provider: "openai-compatible",
  name: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  temperature: 0.2,
  topP: 0.6,
  maxTokens: 1024,
  promptTemplate: "",
  builtIn: false
});

const DEFAULT_LOCAL_PROFILE = Object.freeze({
  id: LEGACY_LOCAL_PROFILE_ID,
  provider: "openai-compatible",
  name: "本地 MLX HY-MT1.5-1.8B",
  baseUrl: "http://127.0.0.1:8080/v1",
  apiKey: "local",
  model: "models/hy-mt1.5-1.8b",
  temperature: 0.2,
  topP: 0.6,
  maxTokens: 1024,
  promptTemplate: DEFAULT_PROMPT_TEMPLATE,
  builtIn: false
});

const DEFAULT_SETTINGS = {
  activeProfileId: DEFAULT_PROFILE_ID,
  apiProfiles: [DEFAULT_MICROSOFT_PROFILE],
  bubbleScale: DEFAULT_BUBBLE_SCALE,
  bubbleWidth: DEFAULT_BUBBLE_WIDTH,
  bubbleHeight: DEFAULT_BUBBLE_HEIGHT,

  // Legacy flat fields kept for backward compatibility with v0.1-v0.3.
  provider: DEFAULT_MICROSOFT_PROFILE.provider,
  targetLanguage: DEFAULT_MICROSOFT_PROFILE.targetLanguage,
  baseUrl: DEFAULT_LOCAL_PROFILE.baseUrl,
  apiKey: DEFAULT_LOCAL_PROFILE.apiKey,
  model: DEFAULT_LOCAL_PROFILE.model,
  temperature: DEFAULT_LOCAL_PROFILE.temperature,
  topP: DEFAULT_LOCAL_PROFILE.topP,
  maxTokens: DEFAULT_LOCAL_PROFILE.maxTokens,
  promptTemplate: DEFAULT_LOCAL_PROFILE.promptTemplate
};

const PROFILE_FIELDS = [
  "provider",
  "name",
  "targetLanguage",
  "baseUrl",
  "apiKey",
  "model",
  "temperature",
  "topP",
  "maxTokens",
  "promptTemplate"
];

let microsoftAuthCache = { token: "", expiresAt: 0 };

function getBrowserApi() {
  if (typeof browser !== "undefined") return browser;
  return chrome;
}

function storageGet(defaults) {
  const api = getBrowserApi();
  if (api.storage && api.storage.local && api.storage.local.get.length === 1) {
    return api.storage.local.get(defaults);
  }
  return new Promise((resolve) => api.storage.local.get(defaults, resolve));
}

function storageSet(values) {
  const api = getBrowserApi();
  if (api.storage && api.storage.local && api.storage.local.set.length === 1) {
    return api.storage.local.set(values);
  }
  return new Promise((resolve) => api.storage.local.set(values, resolve));
}

function makeProfileId(prefix = "api") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeBubbleScale(value) {
  return clampNumber(value, DEFAULT_BUBBLE_SCALE, MIN_BUBBLE_SCALE, MAX_BUBBLE_SCALE);
}

function normalizeBubbleWidth(value) {
  return clampNumber(value, DEFAULT_BUBBLE_WIDTH, MIN_BUBBLE_WIDTH, MAX_BUBBLE_WIDTH);
}

function normalizeBubbleHeight(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_BUBBLE_HEIGHT;
  return clampNumber(num, DEFAULT_BUBBLE_HEIGHT, MIN_BUBBLE_HEIGHT, MAX_BUBBLE_HEIGHT);
}

function normalizeProvider(value, fallback = "openai-compatible") {
  const provider = String(value || fallback || "openai-compatible").trim();
  return provider === "microsoft-free" ? "microsoft-free" : "openai-compatible";
}

function normalizeProfile(profile = {}, fallback = EMPTY_OPENAI_PROFILE) {
  const id = String(profile.id || fallback.id || makeProfileId()).trim();
  const provider = normalizeProvider(profile.provider, id === DEFAULT_PROFILE_ID ? "microsoft-free" : fallback.provider);
  const builtIn = id === DEFAULT_PROFILE_ID;

  if (provider === "microsoft-free") {
    return {
      ...DEFAULT_MICROSOFT_PROFILE,
      id,
      provider,
      name: String(profile.name || fallback.name || DEFAULT_MICROSOFT_PROFILE.name).trim(),
      targetLanguage: String(profile.targetLanguage || fallback.targetLanguage || DEFAULT_MICROSOFT_PROFILE.targetLanguage).trim(),
      builtIn
    };
  }

  return {
    id,
    provider,
    name: String(profile.name ?? fallback.name ?? "").trim(),
    targetLanguage: String(profile.targetLanguage || fallback.targetLanguage || "zh-Hans").trim(),
    baseUrl: String(profile.baseUrl ?? fallback.baseUrl ?? "").trim(),
    apiKey: String(profile.apiKey ?? fallback.apiKey ?? "").trim(),
    model: String(profile.model ?? fallback.model ?? "").trim(),
    temperature: clampNumber(profile.temperature, fallback.temperature ?? 0.2, 0, 2),
    topP: clampNumber(profile.topP, fallback.topP ?? 0.6, 0, 1),
    maxTokens: Math.round(clampNumber(profile.maxTokens, fallback.maxTokens ?? 1024, 1, 200000)),
    promptTemplate: String(profile.promptTemplate ?? fallback.promptTemplate ?? ""),
    builtIn
  };
}

function makeEmptyOpenAIProfile() {
  return normalizeProfile({
    ...EMPTY_OPENAI_PROFILE,
    id: makeProfileId("api"),
    promptTemplate: DEFAULT_PROMPT_TEMPLATE
  }, EMPTY_OPENAI_PROFILE);
}

function legacyProfileFromSaved(saved = {}) {
  const hasLegacyValue = ["baseUrl", "apiKey", "model", "temperature", "topP", "maxTokens", "promptTemplate"]
    .some((field) => saved[field] !== undefined && saved[field] !== DEFAULT_SETTINGS[field]);

  if (!hasLegacyValue) return null;

  return normalizeProfile({
    id: "imported-legacy-settings",
    provider: "openai-compatible",
    name: "旧设置导入",
    baseUrl: saved.baseUrl,
    apiKey: saved.apiKey,
    model: saved.model,
    temperature: saved.temperature,
    topP: saved.topP,
    maxTokens: saved.maxTokens,
    promptTemplate: saved.promptTemplate
  }, DEFAULT_LOCAL_PROFILE);
}

function ensureDefaultProfile(profiles) {
  const normalized = (profiles || [])
    .filter(Boolean)
    .map((profile) => normalizeProfile(profile));

  const defaultIndex = normalized.findIndex((profile) => profile.id === DEFAULT_PROFILE_ID);
  if (defaultIndex === -1) {
    normalized.unshift(normalizeProfile(DEFAULT_MICROSOFT_PROFILE));
  } else {
    normalized[defaultIndex] = {
      ...normalizeProfile(DEFAULT_MICROSOFT_PROFILE),
      ...normalized[defaultIndex],
      id: DEFAULT_PROFILE_ID,
      provider: "microsoft-free",
      builtIn: true
    };
  }

  const seen = new Set();
  return normalized.filter((profile) => {
    if (seen.has(profile.id)) return false;
    seen.add(profile.id);
    return true;
  });
}

function normalizeSettings(saved = {}) {
  let apiProfiles = Array.isArray(saved.apiProfiles) ? saved.apiProfiles : [];

  if (!apiProfiles.length) {
    apiProfiles = [DEFAULT_MICROSOFT_PROFILE];
    const legacy = legacyProfileFromSaved(saved);
    if (legacy) apiProfiles.push(legacy);
  }

  apiProfiles = ensureDefaultProfile(apiProfiles);

  let activeProfileId = String(saved.activeProfileId || "").trim();
  if (!activeProfileId || activeProfileId === LEGACY_LOCAL_PROFILE_ID) activeProfileId = DEFAULT_PROFILE_ID;
  if (!apiProfiles.some((profile) => profile.id === activeProfileId)) activeProfileId = DEFAULT_PROFILE_ID;

  const activeProfile = apiProfiles.find((profile) => profile.id === activeProfileId) || apiProfiles[0];

  return {
    ...DEFAULT_SETTINGS,
    ...activeProfile,
    bubbleScale: normalizeBubbleScale(saved.bubbleScale),
    bubbleWidth: saved.bubbleWidth === undefined && saved.bubbleScale !== undefined
      ? normalizeBubbleWidth(DEFAULT_BUBBLE_WIDTH * normalizeBubbleScale(saved.bubbleScale))
      : normalizeBubbleWidth(saved.bubbleWidth),
    bubbleHeight: normalizeBubbleHeight(saved.bubbleHeight),
    activeProfile,
    activeProfileId: activeProfile.id,
    apiProfiles
  };
}

async function getSettings() {
  const saved = await storageGet(null);
  return normalizeSettings(saved || {});
}

async function saveApiProfiles(apiProfiles, activeProfileId) {
  const normalized = ensureDefaultProfile(apiProfiles);
  const nextActiveId = normalized.some((profile) => profile.id === activeProfileId) ? activeProfileId : DEFAULT_PROFILE_ID;
  await storageSet({
    apiProfiles: normalized,
    activeProfileId: nextActiveId
  });
  return normalizeSettings({ apiProfiles: normalized, activeProfileId: nextActiveId });
}

function buildEndpoint(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (!trimmed) throw new Error("请先填写 OpenAI-compatible API 的 Base URL。");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  return `${trimmed}/chat/completions`;
}

function buildPrompt(template, text) {
  return String(template || DEFAULT_PROMPT_TEMPLATE).replaceAll("{{text}}", text);
}

async function getMicrosoftAuthToken() {
  const now = Date.now();
  if (microsoftAuthCache.token && microsoftAuthCache.expiresAt > now + 30_000) {
    return microsoftAuthCache.token;
  }

  const response = await fetch("https://edge.microsoft.com/translate/auth", { method: "GET" });
  if (!response.ok) throw new Error(`微软翻译授权失败：HTTP ${response.status}`);
  const token = String(await response.text()).trim();
  if (!token) throw new Error("微软翻译没有返回授权 token。");

  microsoftAuthCache = {
    token,
    expiresAt: now + 8 * 60 * 1000
  };
  return token;
}

async function callMicrosoftTranslate(texts, targetLanguage = "zh-Hans", requestOptions = {}) {
  const cleanTexts = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text || "").trim());
  if (!cleanTexts.some(Boolean)) throw new Error("没有可翻译的文本。");

  const token = await getMicrosoftAuthToken();
  const to = encodeURIComponent(String(targetLanguage || "zh-Hans"));
  const endpoint = `https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${to}`;

  const response = await fetch(endpoint, {
    method: "POST",
    signal: requestOptions.signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`
    },
    body: JSON.stringify(cleanTexts.map((text) => ({ Text: text })))
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`微软翻译请求失败：HTTP ${response.status}${errorText ? ` - ${errorText.slice(0, 300)}` : ""}`);
  }

  const data = await response.json();
  return cleanTexts.map((_, index) => {
    const text = data?.[index]?.translations?.[0]?.text || "";
    return String(text).trim();
  });
}

async function callChatCompletion(prompt, overrideSettings = {}, requestOptions = {}) {
  const settings = { ...(await getSettings()), ...overrideSettings };
  const endpoint = buildEndpoint(settings.baseUrl);
  const maxTokens = Number(settings.maxTokens) || 1024;

  if (!settings.model) throw new Error("请先填写 OpenAI-compatible API 的 Model。");

  const response = await fetch(endpoint, {
    method: "POST",
    signal: requestOptions.signal,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey || "local"}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: Number(settings.temperature),
      top_p: Number(settings.topP)
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`API 请求失败：HTTP ${response.status}${errorText ? ` - ${errorText.slice(0, 300)}` : ""}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
  if (!String(text).trim()) throw new Error("API 没有返回内容。");
  return String(text).trim();
}

async function translateText(text, overrideSettings = {}, requestOptions = {}) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("没有可翻译的文本。");

  const settings = { ...(await getSettings()), ...overrideSettings };
  if (settings.provider === "microsoft-free") {
    const [translation] = await callMicrosoftTranslate([cleanText], settings.targetLanguage, requestOptions);
    if (!translation) throw new Error("微软翻译没有返回内容。");
    return translation;
  }

  const prompt = buildPrompt(settings.promptTemplate, cleanText);
  return callChatCompletion(prompt, settings, requestOptions);
}

function buildPageBatchPrompt(blocks) {
  const payload = blocks.map((block, index) => {
    return `<<<LOCAL_MLX_SEG_${index + 1}>>>\n${block.text}`;
  }).join("\n\n");

  return [
    "请将以下多个英文网页片段逐段翻译为自然、准确、流畅的简体中文。",
    "严格要求：",
    "1. 必须保留每个片段前的分隔标记，标记格式为 <<<LOCAL_MLX_SEG_N>>>。",
    "2. 不要翻译、删除、改写、合并或移动这些分隔标记。",
    "3. 每个标记后只输出对应片段的中文译文。",
    "4. 保留代码、URL、Markdown、数字、产品名和专有名词。",
    "5. 不要解释，不要总结，不要添加额外内容。",
    "",
    payload
  ].join("\n");
}

function parsePageBatchResult(rawText, blocks) {
  const raw = String(rawText || "").trim();
  const parsed = new Map();
  const markerRe = /<<<LOCAL_MLX_SEG_(\d+)>>>/g;
  const markers = [];
  let match;

  while ((match = markerRe.exec(raw)) !== null) {
    markers.push({ index: Number(match[1]), start: match.index, end: markerRe.lastIndex });
  }

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i];
    const next = markers[i + 1];
    const text = raw.slice(marker.end, next ? next.start : raw.length).trim();
    if (text) parsed.set(marker.index, text);
  }

  return blocks.map((block, index) => ({
    id: block.id,
    text: parsed.get(index + 1) || ""
  }));
}

async function translatePageBlocks(blocks, overrideSettings = {}, requestOptions = {}) {
  const cleanBlocks = (blocks || [])
    .map((block) => ({ id: block.id, text: String(block.text || "").trim() }))
    .filter((block) => block.id && block.text);

  if (!cleanBlocks.length) return [];

  const settings = { ...(await getSettings()), ...overrideSettings };

  if (settings.provider === "microsoft-free") {
    const translated = await callMicrosoftTranslate(cleanBlocks.map((block) => block.text), settings.targetLanguage, requestOptions);
    return cleanBlocks.map((block, index) => ({ id: block.id, text: translated[index] || "" }));
  }

  const prompt = buildPageBatchPrompt(cleanBlocks);
  const raw = await callChatCompletion(prompt, {
    ...settings,
    maxTokens: Math.max(Number(settings.maxTokens) || 0, Number(overrideSettings.maxTokens) || 0, 2048)
  }, requestOptions);

  const parsed = parsePageBatchResult(raw, cleanBlocks);
  const missing = parsed.filter((item) => !item.text);

  if (!missing.length) return parsed;

  const byId = new Map(parsed.map((item) => [item.id, item.text]));
  for (const block of cleanBlocks) {
    if (byId.get(block.id)) continue;
    byId.set(block.id, await translateText(block.text, settings, requestOptions));
  }

  return cleanBlocks.map((block) => ({ id: block.id, text: byId.get(block.id) || "" }));
}
