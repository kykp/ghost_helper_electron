// AI Ghost — overlay (renderer). Собирает всё вместе:
// два источника звука → VAD → Whisper → диалоговый буфер → триггеры →
// запрос в GPT → показ подсказки.

const buffer = new TranscriptBuffer(180000); // диалог за 3 мин
const screenCapture = new ScreenCapture();

// Микрофон — мой голос; системный звук — голос собеседника.
const micListener = new VadListener("me");
const sysListener = new VadListener("them");

let triggers = null;
let ai = null;
let settings = {
  lang: "ru",
  minInterval: 10,
  silenceThreshold: 5,
};

let started = false;
let micOn = true;
let requesting = false; // запрос в GPT уже идёт — не плодим параллельные
let topicInterval = null;
let tickInterval = null;

// --- Режим live coding ---
// Определяется по первому скриншоту: если на экране IDE/редактор кода —
// дальше скриншоты прикладываются к запросам автоматически.
let liveCodingMode = false;
let liveCodingChecked = false;

// --- Источники звука ---
function getMicStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

// Системный звук — loopback через getDisplayMedia (обрабатывается в main.js).
async function getSystemStream() {
  const ds = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });
  ds.getVideoTracks().forEach((t) => t.stop()); // видео не нужно — только звук
  const audio = ds.getAudioTracks();
  if (!audio.length) throw new Error("loopback без аудио-дорожки");
  return new MediaStream(audio);
}

// --- Загрузка ключа и настроек ---
async function loadConfig() {
  const apiKey = await window.ghostAPI.getApiKey();
  const s = await window.ghostAPI.getSettings();
  if (s) settings = { ...settings, ...s };
  return apiKey || "";
}

// --- Инициализация ---
async function init() {
  const apiKey = await loadConfig();

  if (!apiKey) {
    addMessage("⚙️ Откройте настройки (Cmd+Shift+S) и введите API-ключ OpenAI");
    showStatus("error");
    return;
  }

  ai = new OpenAIClient(apiKey);

  triggers = new TriggerManager({
    minIntervalSec: settings.minInterval,
    silenceThresholdSec: settings.silenceThreshold,
  });
  triggers.onTrigger = (reason, withScreenshot) =>
    requestHint(reason, withScreenshot);

  micListener.configure({ apiKey, lang: settings.lang });
  sysListener.configure({ apiKey, lang: settings.lang });

  for (const L of [micListener, sysListener]) {
    L.onSpeechStart = (source) => triggers.handleSpeechStart(source);
    L.onSpeechEnd = (source) => triggers.handleSpeechEnd(source);
    L.onUtterance = handleUtterance;
  }

  // Доступ к записи экрана (нужен и для скриншотов, и для loopback-аудио).
  const access = await screenCapture.access();
  if (access !== "granted") {
    addMessage(
      "🖥 Разрешите «Запись экрана» в Системных настройках → Конфиденциальность и перезапустите AI Ghost"
    );
  }

  // Микрофон — обязателен.
  try {
    await micListener.start(getMicStream);
  } catch (e) {
    console.error("mic VAD:", e);
    addMessage(
      "🎤 Нет доступа к микрофону. Разрешите его в Системных настройках и перезапустите AI Ghost."
    );
    showStatus("error");
    return;
  }

  started = true;
  showStatus("listening");

  // Системный звук — желателен, но не критичен.
  try {
    await sysListener.start(getSystemStream);
  } catch (e) {
    console.warn("system audio VAD:", e);
    addMessage(
      "🔈 Не удалось захватить системный звук — голос собеседника слышен не будет. " +
        "Проверьте разрешение «Запись экрана»."
    );
  }

  // Тик триггеров — реализует отложенные и срочные срабатывания.
  tickInterval = setInterval(() => {
    if (triggers) triggers.tick();
  }, 500);

  // Проверка смены темы — последние 30 сек против предыдущих 30 сек.
  topicInterval = setInterval(() => {
    if (!triggers) return;
    const recent = buffer.getRange(30, 0);
    const previous = buffer.getRange(60, 30);
    if (recent && previous) triggers.checkTopicChange(recent, previous);
  }, 15000);
}

// --- Новая распознанная реплика ---
function handleUtterance({ source, text, isRepeat }) {
  if (!text) return;

  // Ручной повтор распознавания (Cmd+Shift+R): трактуем как уточнённый
  // вопрос и сразу просим подсказку, минуя обычные триггеры.
  if (isRepeat) {
    buffer.add(text, "them");
    setTicker("⟳ " + text);
    if (triggers) triggers.noteExternalRequest();
    requestHint("Повтор вопроса", false);
    return;
  }

  if (source === "me" && !micOn) return; // микрофон выключен — игнорируем

  buffer.add(text, source);
  setTicker((source === "me" ? "Я: " : "Собеседник: ") + text);
  if (triggers) triggers.handleUtterance({ source, text });
}

// --- Запрос подсказки ---
async function requestHint(reason, withScreenshot = false) {
  if (!ai || requesting) return;
  requesting = true;
  showStatus("thinking");

  try {
    const wantScreenshot = withScreenshot || liveCodingMode;
    const screenshot = wantScreenshot ? await screenCapture.capture() : null;

    // По первому же скриншоту определяем, идёт ли live coding.
    if (screenshot && !liveCodingChecked) {
      liveCodingChecked = true;
      liveCodingMode = await ai.detectLiveCoding(screenshot);
    }

    const dialog = buffer.getDialog(60);
    const mode = liveCodingMode ? "live coding" : "разговор";
    const hint = await ai.getHint({ dialog, screenshot, reason, mode });
    const hasContent =
      hint && (hint.short || hint.detailed) && hint.short !== "—";
    if (hasContent) addHint(hint, reason);
  } catch (e) {
    console.error("requestHint:", e);
  } finally {
    requesting = false;
    showStatus(!started ? "error" : micOn ? "listening" : "muted");
  }
}

// --- UI: лента ответов ---
// Системное сообщение (ошибка / инструкция по настройке).
function addMessage(text) {
  const list = document.getElementById("hint-list");
  const msg = document.createElement("div");
  msg.className = "hint-msg system";
  const body = document.createElement("div");
  body.className = "hint-text";
  body.textContent = text;
  msg.appendChild(body);
  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

// Структурированный ответ. Блоки НИКОГДА не удаляются и не заменяются —
// каждый новый вопрос только добавляет новый блок снизу.
function addHint(hint, reason) {
  const list = document.getElementById("hint-list");
  const msg = document.createElement("div");
  msg.className = "hint-msg";

  if (reason) {
    const trigger = document.createElement("div");
    trigger.className = "hint-trigger";
    trigger.textContent = reason.toLowerCase();
    msg.appendChild(trigger);
  }

  // Краткий ответ — сверху.
  if (hint.short) {
    const short = document.createElement("div");
    short.className = "hint-short";
    short.textContent = hint.short;
    msg.appendChild(short);
  }

  // Развёрнутый ответ — ниже, с примерами кода.
  if (hint.detailed) {
    const detailed = document.createElement("div");
    detailed.className = "hint-detailed";
    renderRichText(detailed, hint.detailed);
    msg.appendChild(detailed);
  }

  // Уточняющие вопросы — внизу блока.
  if (hint.followups && hint.followups.length) {
    const fu = document.createElement("div");
    fu.className = "hint-followups";
    const title = document.createElement("div");
    title.className = "hint-followups-title";
    title.textContent = "Уточняющие вопросы";
    fu.appendChild(title);
    for (const q of hint.followups) {
      const row = document.createElement("div");
      row.className = "hint-followup";
      row.textContent = q;
      fu.appendChild(row);
    }
    msg.appendChild(fu);
  }

  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
}

// Текст с код-блоками в тройных кавычках ```…``` → абзацы + <pre><code>.
function renderRichText(container, text) {
  const parts = String(text).split("```");
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const pre = document.createElement("pre");
      pre.className = "hint-code";
      const code = document.createElement("code");
      // Убираем ярлык языка из первой строки (```js, ```tsx и т.п.).
      code.textContent = part.replace(/^[a-zA-Z0-9+#.-]*\n/, "").trimEnd();
      pre.appendChild(code);
      container.appendChild(pre);
    } else {
      const t = part.trim();
      if (!t) return;
      const para = document.createElement("div");
      para.className = "hint-para";
      para.textContent = t;
      container.appendChild(para);
    }
  });
}

function clearMessages() {
  document.getElementById("hint-list").innerHTML = "";
}

const STATUS_LABELS = {
  listening: "слушаю",
  thinking: "думаю…",
  error: "ошибка",
  muted: "микрофон выкл",
};

function showStatus(status) {
  document.getElementById("status-dot").className = status;
  document.getElementById("status-label").textContent =
    STATUS_LABELS[status] || status;
}

// --- Бегущая строка распознанной речи ---
function setTicker(text, active = true) {
  const el = document.getElementById("ticker-text");
  el.textContent = text;
  el.classList.toggle("active", active && !!text);
}

// --- Микрофон: ручное вкл/выкл ---
function updateMicButton() {
  const btn = document.getElementById("mic-toggle");
  btn.textContent = micOn ? "🎙" : "🔇";
  btn.classList.toggle("off", !micOn);
  btn.title = (micOn ? "Выключить" : "Включить") + " микрофон — Cmd+Shift+M";
}

function setMic(on) {
  if (!started || on === micOn) return;
  micOn = on;
  updateMicButton();
  if (on) {
    micListener.resume();
    showStatus("listening");
    setTicker("…ожидание речи", false);
  } else {
    micListener.pause();
    showStatus("muted");
    setTicker("микрофон выключен", false);
  }
}

document
  .getElementById("mic-toggle")
  .addEventListener("click", () => setMic(!micOn));
window.ghostAPI.onToggleMic(() => setMic(!micOn));
updateMicButton();

// --- События из main process ---
// Ручной запрос (Cmd+Shift+P) — всегда со скриншотом.
window.ghostAPI.onForceHint(() => {
  if (!started) return;
  if (triggers) triggers.noteExternalRequest();
  requestHint("Ручной запрос", true);
});

// Повтор распознавания последних 10 сек микрофона (Cmd+Shift+R).
window.ghostAPI.onRepeatQuestion(async () => {
  if (!started) return;
  showStatus("thinking");
  const text = await micListener.repeatLast(10);
  if (!text) {
    showStatus(micOn ? "listening" : "muted");
    setTicker("⟳ нечего переспрашивать", false);
  }
});

// Кнопка 📸 — ручной запрос со скриншотом.
document.getElementById("shot-btn").addEventListener("click", () => {
  if (!started) return;
  if (triggers) triggers.noteExternalRequest();
  requestHint("Запрос по экрану", true);
});

// Очистка ленты — кнопка 🗑.
document.getElementById("clear-btn").addEventListener("click", clearMessages);

// --- Размер шрифта ленты — кнопки A− / A+ ---
let hintFontSize = 14;
function setHintFont(size) {
  hintFontSize = Math.max(11, Math.min(22, size));
  document.documentElement.style.setProperty("--hint-font", hintFontSize + "px");
}
document
  .getElementById("font-dec")
  .addEventListener("click", () => setHintFont(hintFontSize - 1));
document
  .getElementById("font-inc")
  .addEventListener("click", () => setHintFont(hintFontSize + 1));

// --- Применение изменённых настроек ---
window.ghostAPI.onSettingsUpdated(async () => {
  const apiKey = await loadConfig();

  if (apiKey && !started) {
    init();
    return;
  }
  if (ai && apiKey) ai.setApiKey(apiKey);
  micListener.configure({ apiKey, lang: settings.lang });
  sysListener.configure({ apiKey, lang: settings.lang });
  if (triggers) {
    triggers.setMinInterval(settings.minInterval);
    triggers.setSilenceThreshold(settings.silenceThreshold);
  }
});

init();
