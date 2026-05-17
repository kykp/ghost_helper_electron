// AI Ghost — окно настроек.

const el = {
  apiKey: document.getElementById("apiKey"),
  toggleKey: document.getElementById("toggleKey"),
  lang: document.getElementById("lang"),
  minInterval: document.getElementById("minInterval"),
  silenceThreshold: document.getElementById("silenceThreshold"),
  minIntervalVal: document.getElementById("minIntervalVal"),
  silenceThresholdVal: document.getElementById("silenceThresholdVal"),
  testBtn: document.getElementById("testBtn"),
  testDot: document.getElementById("testDot"),
  testStatus: document.getElementById("testStatus"),
  saveBtn: document.getElementById("saveBtn"),
  closeBtn: document.getElementById("closeBtn"),
};

// Полные текущие настройки — храним, чтобы при сохранении не затереть
// поля без UI (например fontSize, которым управляет оверлей).
let savedSettings = {};

// --- Загрузка текущих значений ---
async function load() {
  el.apiKey.value = (await window.ghostAPI.getApiKey()) || "";
  savedSettings = (await window.ghostAPI.getSettings()) || {};
  el.lang.value = savedSettings.lang || "ru";
  el.minInterval.value = savedSettings.minInterval ?? 10;
  el.silenceThreshold.value = savedSettings.silenceThreshold ?? 5;
  syncLabels();
}

function syncLabels() {
  el.minIntervalVal.textContent = el.minInterval.value;
  el.silenceThresholdVal.textContent = el.silenceThreshold.value;
}

["minInterval", "silenceThreshold"].forEach((k) => {
  el[k].addEventListener("input", syncLabels);
});

// --- Показать / скрыть ключ ---
el.toggleKey.addEventListener("click", () => {
  el.apiKey.type = el.apiKey.type === "password" ? "text" : "password";
});

// --- Проверка ключа ---
el.testBtn.addEventListener("click", async () => {
  const key = el.apiKey.value.trim();
  if (!key) {
    setTest("fail", "введите ключ");
    return;
  }
  setTest("", "проверяю...");
  const res = await window.ghostAPI.testApiKey(key);
  if (res.ok) setTest("ok", "ключ работает");
  else setTest("fail", res.error || "ошибка");
});

function setTest(state, text) {
  el.testDot.className = "tdot" + (state ? " " + state : "");
  el.testStatus.textContent = text;
}

// --- Сохранение ---
el.saveBtn.addEventListener("click", async () => {
  await window.ghostAPI.setApiKey(el.apiKey.value.trim());
  await window.ghostAPI.setSettings({
    ...savedSettings, // сохраняем поля без UI (fontSize и т.п.)
    lang: el.lang.value,
    minInterval: Number(el.minInterval.value),
    silenceThreshold: Number(el.silenceThreshold.value),
  });
  el.saveBtn.textContent = "Сохранено ✓";
  setTimeout(() => {
    el.saveBtn.textContent = "Сохранить";
  }, 1500);
});

// --- Закрыть ---
el.closeBtn.addEventListener("click", () => window.ghostAPI.closeSettings());

load();
