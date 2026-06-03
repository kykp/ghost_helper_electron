// AI Ghost — окно настроек.

const el = {
  apiKey: document.getElementById("apiKey"),
  toggleKey: document.getElementById("toggleKey"),
  lang: document.getElementById("lang"),
  minInterval: document.getElementById("minInterval"),
  pauseSec: document.getElementById("pauseSec"),
  maxWaitSec: document.getElementById("maxWaitSec"),
  opacity: document.getElementById("opacity"),
  fontSize: document.getElementById("fontSize"),
  minIntervalVal: document.getElementById("minIntervalVal"),
  pauseSecVal: document.getElementById("pauseSecVal"),
  maxWaitSecVal: document.getElementById("maxWaitSecVal"),
  opacityVal: document.getElementById("opacityVal"),
  fontSizeVal: document.getElementById("fontSizeVal"),
  testBtn: document.getElementById("testBtn"),
  testDot: document.getElementById("testDot"),
  testStatus: document.getElementById("testStatus"),
  saveBtn: document.getElementById("saveBtn"),
  closeBtn: document.getElementById("closeBtn"),
};

// Полные текущие настройки — храним, чтобы при сохранении не затереть
// поля, для которых здесь нет элемента управления.
let savedSettings = {};

// --- Загрузка текущих значений ---
async function load() {
  el.apiKey.value = (await window.ghostAPI.getApiKey()) || "";
  savedSettings = (await window.ghostAPI.getSettings()) || {};
  el.lang.value = savedSettings.lang || "ru";
  el.minInterval.value = savedSettings.minInterval ?? 3;
  el.pauseSec.value = savedSettings.pauseSec ?? 0.6;
  el.maxWaitSec.value = savedSettings.maxWaitSec ?? 7;
  el.opacity.value = Math.round((savedSettings.opacity ?? 0.72) * 100);
  el.fontSize.value = savedSettings.fontSize ?? 20;
  syncLabels();
}

function syncLabels() {
  el.minIntervalVal.textContent = el.minInterval.value;
  el.pauseSecVal.textContent = el.pauseSec.value;
  el.maxWaitSecVal.textContent = el.maxWaitSec.value;
  el.opacityVal.textContent = el.opacity.value;
  el.fontSizeVal.textContent = el.fontSize.value;
}

["minInterval", "pauseSec", "maxWaitSec", "opacity", "fontSize"].forEach((k) => {
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
    ...savedSettings, // сохраняем поля, для которых здесь нет UI
    lang: el.lang.value,
    minInterval: Number(el.minInterval.value),
    pauseSec: Number(el.pauseSec.value),
    maxWaitSec: Number(el.maxWaitSec.value),
    opacity: Number(el.opacity.value) / 100,
    fontSize: Number(el.fontSize.value),
  });
  el.saveBtn.textContent = "Сохранено ✓";
  setTimeout(() => {
    el.saveBtn.textContent = "Сохранить";
  }, 1500);
});

// --- Закрыть ---
el.closeBtn.addEventListener("click", () => window.ghostAPI.closeSettings());

load();
