const fields = ["provider", "name", "targetLanguage", "baseUrl", "apiKey", "model", "temperature", "topP", "maxTokens", "promptTemplate"];
const profileListEl = document.getElementById("profileList");
const statusEl = document.getElementById("status");
const saveProfileBtn = document.getElementById("saveProfile");
const setActiveBtn = document.getElementById("setActive");
const deleteProfileBtn = document.getElementById("deleteProfile");
const newProfileBtn = document.getElementById("newProfile");
const duplicateProfileBtn = document.getElementById("duplicateProfile");
const microsoftSection = document.getElementById("microsoftSection");
const openaiSection = document.getElementById("openaiSection");
const generationSection = document.getElementById("generationSection");
const promptSection = document.getElementById("promptSection");

let profiles = [];
let activeProfileId = DEFAULT_PROFILE_ID;
let selectedProfileId = DEFAULT_PROFILE_ID;

function setStatus(text) {
  statusEl.textContent = text;
  if (text) setTimeout(() => {
    if (statusEl.textContent === text) statusEl.textContent = "";
  }, 1800);
}

function currentProfile() {
  return profiles.find((profile) => profile.id === selectedProfileId) || profiles[0];
}

function setSectionMode(profile) {
  const provider = profile?.provider || "openai-compatible";
  const isMicrosoft = provider === "microsoft-free";
  microsoftSection.hidden = !isMicrosoft;
  openaiSection.hidden = isMicrosoft;
  generationSection.hidden = isMicrosoft;
  promptSection.hidden = isMicrosoft;
}

function readFormProfile() {
  const existing = currentProfile() || DEFAULT_MICROSOFT_PROFILE;
  const values = { id: existing.id, provider: existing.provider, builtIn: existing.id === DEFAULT_PROFILE_ID };
  for (const field of fields) {
    const el = document.getElementById(field);
    if (el) values[field] = el.value;
  }
  values.temperature = Number(values.temperature || 0.2);
  values.topP = Number(values.topP || 0.6);
  values.maxTokens = Number(values.maxTokens || 1024);
  return normalizeProfile(values, existing.provider === "microsoft-free" ? DEFAULT_MICROSOFT_PROFILE : EMPTY_OPENAI_PROFILE);
}

function writeForm(profile) {
  const normalized = normalizeProfile(profile);
  setSectionMode(normalized);
  for (const field of fields) {
    const el = document.getElementById(field);
    if (!el) continue;
    el.value = normalized[field] ?? "";
  }
  deleteProfileBtn.disabled = normalized.id === DEFAULT_PROFILE_ID;
  setActiveBtn.disabled = normalized.id === activeProfileId;
}

function getProfileMeta(profile) {
  if (profile.provider === "microsoft-free") return `微软免费翻译 · ${profile.targetLanguage || "zh-Hans"}`;
  const model = profile.model || "未填写 Model";
  const baseUrl = profile.baseUrl || "未填写 Base URL";
  return `${model} · ${baseUrl}`;
}

function renderProfileList() {
  profileListEl.innerHTML = "";

  for (const profile of profiles) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `profile-item${profile.id === selectedProfileId ? " active" : ""}`;
    button.innerHTML = `
      <div class="profile-title">
        <span></span>
        <span></span>
      </div>
      <div class="profile-meta"></div>
    `;
    button.querySelector(".profile-title span:first-child").textContent = profile.name || "未命名配置";
    const badges = [];
    if (profile.id === activeProfileId) badges.push("当前");
    if (profile.id === DEFAULT_PROFILE_ID) badges.push("默认");
    button.querySelector(".profile-title span:last-child").innerHTML = badges.map((badge) => `<span class="badge">${badge}</span>`).join(" ");
    button.querySelector(".profile-meta").textContent = getProfileMeta(profile);
    button.addEventListener("click", () => selectProfile(profile.id));
    profileListEl.appendChild(button);
  }
}

function selectProfile(id) {
  selectedProfileId = id;
  renderProfileList();
  writeForm(currentProfile());
}

async function persist(nextProfiles = profiles, nextActiveId = activeProfileId) {
  const normalized = await saveApiProfiles(nextProfiles, nextActiveId);
  profiles = normalized.apiProfiles;
  activeProfileId = normalized.activeProfileId;
  if (!profiles.some((profile) => profile.id === selectedProfileId)) selectedProfileId = activeProfileId;
  renderProfileList();
  writeForm(currentProfile());
}

async function loadOptions() {
  const settings = await getSettings();
  profiles = settings.apiProfiles;
  activeProfileId = settings.activeProfileId;
  selectedProfileId = activeProfileId;
  renderProfileList();
  writeForm(currentProfile());
}

async function saveSelectedProfile({ makeActive = false } = {}) {
  const next = readFormProfile();
  profiles = profiles.map((profile) => profile.id === next.id ? next : profile);
  await persist(profiles, makeActive ? next.id : activeProfileId);
  setStatus(makeActive ? "已保存并设为当前。" : "已保存。");
}

newProfileBtn.addEventListener("click", async () => {
  const profile = makeEmptyOpenAIProfile();
  profiles.push(profile);
  selectedProfileId = profile.id;
  await persist(profiles, activeProfileId);
  setStatus("已新增空白 API 配置。");
});

duplicateProfileBtn.addEventListener("click", async () => {
  const source = readFormProfile();
  const profile = normalizeProfile({
    ...source,
    id: makeProfileId("copy"),
    name: source.name ? `${source.name} 副本` : "配置副本",
    builtIn: false
  }, source);
  profiles.push(profile);
  selectedProfileId = profile.id;
  await persist(profiles, activeProfileId);
  setStatus("已复制当前配置。");
});

saveProfileBtn.addEventListener("click", () => saveSelectedProfile());

setActiveBtn.addEventListener("click", async () => {
  await saveSelectedProfile({ makeActive: true });
});

deleteProfileBtn.addEventListener("click", async () => {
  const profile = currentProfile();
  if (!profile || profile.id === DEFAULT_PROFILE_ID) {
    setStatus("默认配置不可删除。");
    return;
  }
  if (!confirm(`删除“${profile.name || "未命名配置"}”？`)) return;
  profiles = profiles.filter((item) => item.id !== profile.id);
  selectedProfileId = activeProfileId === profile.id ? DEFAULT_PROFILE_ID : activeProfileId;
  await persist(profiles, selectedProfileId);
  setStatus("已删除配置。");
});

loadOptions();
