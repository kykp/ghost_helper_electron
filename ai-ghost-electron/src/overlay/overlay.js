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
let micOn = false; // микрофон по умолчанию выключен — включается кнопкой 🎙
let sysOn = true; // системный звук (голос собеседника) слушаем по умолчанию
let requesting = false; // запрос в GPT уже идёт — не плодим параллельные
let lastRequestTs = 0; // время последней реплики на момент прошлого запроса
let topicInterval = null;
let tickInterval = null;

// Скриншоты для режима «решение задачи» — до MAX_SHOTS штук (base64 JPEG).
const MAX_SHOTS = 5;
let shots = [];

// Активная решённая задача. Пока она задана — весь разговор трактуется как
// обсуждение этой задачи: ответы идут в её контексте. Сброс — кнопкой 🗑.
let lastTask = null; // { images: [base64], solution: hint }

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

// Плотность фона и размер шрифта ленты задаются в окне настроек.
// Прозрачность меняет только фон — текст рисуется поверх и остаётся чётким.
function setPanelAlpha(a) {
  document.documentElement.style.setProperty("--panel-alpha", a);
}

function applyPanelAlpha() {
  setPanelAlpha(typeof settings.opacity === "number" ? settings.opacity : 0.72);
}

function applyHintFont() {
  const px = typeof settings.fontSize === "number" ? settings.fontSize : 14;
  document.documentElement.style.setProperty("--hint-font", px + "px");
}

// --- Инициализация ---
async function init() {
  const apiKey = await loadConfig();
  applyPanelAlpha();
  applyHintFont();

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
  triggers.onTrigger = (reason) => requestHint(reason);

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

  started = true;
  showStatus(micOn ? "listening" : "muted");
  setTicker(micOn ? "…ожидание речи" : "микрофон выключен — кнопка 🎙", false);
  renderShots(); // приложение запущено — кнопка «Снимок» активна

  // Системный звук собеседника — желателен, но не критичен.
  try {
    await sysListener.start(getSystemStream);
  } catch (e) {
    console.warn("system audio VAD:", e);
    addMessage(
      "🔈 Не удалось захватить системный звук — голос собеседника слышен не будет. " +
        "Проверьте разрешение «Запись экрана»."
    );
  }

  // Микрофон по умолчанию выключен — стартует лениво по кнопке 🎙 (см. setMic).
  if (micOn) {
    try {
      await micListener.start(getMicStream);
    } catch (e) {
      console.error("mic VAD:", e);
      micOn = false;
      updateMicButton();
      showStatus("muted");
      addMessage(
        "🎤 Нет доступа к микрофону. Разрешите его в Системных настройках."
      );
    }
  }

  // Тик триггеров — реализует отложенные и срочные срабатывания.
  tickInterval = setInterval(() => {
    if (triggers) triggers.tick();
  }, 250);

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
    requestHint("Повтор вопроса", { force: true });
    return;
  }

  if (source === "me" && !micOn) return; // микрофон выключен — игнорируем
  if (source === "them" && !sysOn) return; // собеседник не прослушивается

  buffer.add(text, source);
  setTicker((source === "me" ? "Я: " : "Собеседник: ") + text);
  if (triggers) triggers.handleUtterance({ source, text });
}

// --- Запрос подсказки по триггеру ---
// Если активна задача (lastTask) — ответ в её контексте (discussTask);
// иначе обычная голосовая подсказка по диалогу.
async function requestHint(reason, opts = {}) {
  if (!ai || requesting) return;

  // Антидубль: на один вопрос срабатывает несколько триггеров. Если с
  // прошлого запроса в диалоге не появилось новых реплик — не отвечаем
  // повторно на тот же вопрос. Ручной запрос (Cmd+Shift+P) не ограничен.
  const lastEntry = buffer.last();
  const lastTs = lastEntry ? lastEntry.timestamp : 0;
  if (!opts.force && lastTs && lastTs === lastRequestTs) return;
  lastRequestTs = lastTs;

  requesting = true;
  showStatus("thinking");

  let block = null; // блок ответа создаём лениво — при первом куске текста

  // Живой показ ответа по мере стриминга.
  const onProgress = ({ short, detailed }) => {
    if (short === "—") return; // модель сообщает «подсказка не нужна»
    if (!short && !detailed) return;
    if (!block) block = createHintBlock(reason);
    streamHintBlock(block, { short, detailed });
  };

  try {
    const dialog = buffer.getDialog(60);
    let hint;
    if (lastTask) {
      // Задача активна — отвечаем в её контексте (reasoning-модель, без
      // стриминга): уточняем решение или отвечаем на вопрос о нём.
      hint = await ai.discussTask(lastTask.images, lastTask.solution, dialog);
    } else {
      // Обычная голосовая подсказка по диалогу — со стримингом.
      hint = await ai.getHint({ dialog, reason }, onProgress);
    }
    const hasContent =
      hint && (hint.short || hint.detailed) && hint.short !== "—";
    if (hasContent) {
      if (!block) block = createHintBlock(reason);
      fillHintBlock(block, hint); // финальный рендер: код, уточнения
      // Дальнейшее обсуждение строим уже от свежего решения.
      if (lastTask) lastTask = { images: lastTask.images, solution: hint };
    } else if (block) {
      block.msg.remove(); // стримили, но финальный ответ пустой
    }
  } catch (e) {
    console.error("requestHint:", e);
    if (block) block.msg.remove();
  } finally {
    requesting = false;
    showStatus(!started ? "error" : micOn ? "listening" : "muted");
  }
}

// --- Скриншоты: режим «решение задачи по коду» ---
// Жмём «Снимок» — оверлей прячется, появляется нативное выделение macOS:
// тянем рамку по нужной области, отпускаем — снимок добавлен. Так можно
// собрать до MAX_SHOTS снимков и отправить всё одним запросом в GPT.

async function captureShot() {
  if (!started || shots.length >= MAX_SHOTS) return;
  const img = await screenCapture.captureInteractive();
  if (!img) {
    setTicker("⚠ снимок не сделан (выделение отменено)", false);
    return;
  }
  shots.push(img);
  renderShots();
}

function removeShot(index) {
  shots.splice(index, 1);
  renderShots();
}

function renderShots() {
  const strip = document.getElementById("shots-thumbs");
  strip.innerHTML = "";

  shots.forEach((img, i) => {
    const thumb = document.createElement("div");
    thumb.className = "shot-thumb";

    const im = document.createElement("img");
    im.src = "data:image/jpeg;base64," + img;
    thumb.appendChild(im);

    const del = document.createElement("button");
    del.className = "shot-del";
    del.textContent = "✕";
    del.title = "Убрать снимок";
    del.addEventListener("click", () => removeShot(i));
    setupDwell(del); // удаление снимка — тоже по удержанию курсора
    thumb.appendChild(del);

    strip.appendChild(thumb);
  });

  document.getElementById("shots-count").textContent =
    shots.length + " / " + MAX_SHOTS;
  document.getElementById("shots-capture").disabled =
    !started || shots.length >= MAX_SHOTS;
  document.getElementById("shots-solve").disabled =
    !started || shots.length === 0;
}

// Отправить накопленные скриншоты в GPT и показать решение задачи.
async function solveShots() {
  if (!started || !ai || requesting || !shots.length) return;
  requesting = true;
  showStatus("thinking");
  const sent = shots.slice(); // запоминаем — пригодятся для уточнений
  try {
    const hint = await ai.solveTask(sent);
    if (hint && (hint.short || hint.detailed)) {
      addHint(hint, "Решение задачи по скриншотам");
      lastTask = { images: sent, solution: hint }; // цель для уточнений
      shots = []; // решение получено — освобождаем слоты под новую задачу
      renderShots();
    } else {
      setTicker("⚠ не удалось разобрать задачу", false);
    }
  } catch (e) {
    console.error("solveTask:", e);
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

// Создаёт пустой блок ответа в ленте; возвращает ссылки для наполнения —
// в т.ч. постепенного, во время стриминга. Блоки НИКОГДА не удаляются
// после показа: каждый новый вопрос добавляет новый блок снизу.
function createHintBlock(reason) {
  const list = document.getElementById("hint-list");
  const msg = document.createElement("div");
  msg.className = "hint-msg";

  if (reason) {
    const trigger = document.createElement("div");
    trigger.className = "hint-trigger";
    trigger.textContent = reason.toLowerCase();
    msg.appendChild(trigger);
  }

  const short = document.createElement("div");
  short.className = "hint-short";
  short.style.display = "none";
  msg.appendChild(short);

  const detailed = document.createElement("div");
  detailed.className = "hint-detailed";
  detailed.style.display = "none";
  msg.appendChild(detailed);

  list.appendChild(msg);
  list.scrollTop = list.scrollHeight;
  return { msg, short, detailed };
}

// Промежуточное наполнение во время стриминга — простой текст, без
// разметки код-блоков (она появится в финальном fillHintBlock).
function streamHintBlock(block, { short, detailed }) {
  block.short.textContent = short;
  block.short.style.display = short ? "" : "none";
  block.detailed.textContent = detailed;
  block.detailed.style.display = detailed ? "" : "none";
  const list = document.getElementById("hint-list");
  list.scrollTop = list.scrollHeight;
}

// Финальное наполнение блока структурированным ответом: код-блоки в
// развёрнутой части и уточняющие вопросы снизу.
function fillHintBlock(block, hint) {
  block.short.textContent = hint.short || "";
  block.short.style.display = hint.short ? "" : "none";

  block.detailed.innerHTML = "";
  if (hint.detailed) {
    renderRichText(block.detailed, hint.detailed);
    block.detailed.style.display = "";
  } else {
    block.detailed.style.display = "none";
  }

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
    block.msg.appendChild(fu);
  }

  const list = document.getElementById("hint-list");
  list.scrollTop = list.scrollHeight;
}

// Готовый ответ одним куском (режим скриншотов — там стриминга нет).
function addHint(hint, reason) {
  fillHintBlock(createHintBlock(reason), hint);
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

// Очистка беседы — стираем ленту и весь контекст вопроса, чтобы следующий
// вопрос обрабатывался с чистого листа: буфер диалога, контекст модели,
// состояние триггеров и антидубль.
function clearConversation() {
  document.getElementById("hint-list").innerHTML = "";
  buffer.clear();
  lastRequestTs = 0;
  shots = []; // снимки и решённая задача — тоже под ноль
  lastTask = null;
  if (ai) ai.clearContext();
  if (triggers) triggers.reset();
  renderShots();
  setTicker("беседа очищена — новый вопрос", false);
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
  btn.textContent = micOn ? "Мой микрофон вкл" : "Мой микрофон выкл";
  btn.classList.toggle("off", !micOn);
  btn.title = (micOn ? "Выключить" : "Включить") + " мой микрофон — Cmd+Shift+M";
}

async function setMic(on) {
  if (!started || on === micOn) return;
  micOn = on;
  updateMicButton();
  if (on) {
    try {
      // Первое включение — лениво стартуем VAD-микрофон; далее resume.
      if (!micListener.running) await micListener.start(getMicStream);
      else micListener.resume();
      showStatus("listening");
      setTicker("…ожидание речи", false);
    } catch (e) {
      console.error("mic VAD:", e);
      micOn = false;
      updateMicButton();
      showStatus("muted");
      setTicker("нет доступа к микрофону", false);
    }
  } else {
    micListener.pause();
    // Снимаем возможный залипший флаг речи: если выключили микрофон посреди
    // фразы, парный onSpeechEnd("me") от VAD уже не придёт — без этого
    // triggers.anyoneSpeaking навсегда true и tick() перестаёт срабатывать.
    if (triggers) triggers.handleSpeechEnd("me");
    showStatus("muted");
    setTicker("микрофон выключен", false);
  }
}

document
  .getElementById("mic-toggle")
  .addEventListener("click", () => setMic(!micOn));
window.ghostAPI.onToggleMic(() => setMic(!micOn));
updateMicButton();

// --- Системный звук собеседника: ручное вкл/выкл ---
// Когда выключено — VAD-источник «them» на паузе, реплики собеседующего
// не распознаются и не дёргают подсказки.
function updateSysButton() {
  const btn = document.getElementById("sys-toggle");
  btn.textContent = sysOn ? "Собеседник вкл" : "Собеседник выкл";
  btn.classList.toggle("off", !sysOn);
  btn.title =
    (sysOn ? "Не слушать" : "Слушать") + " микрофон собеседника";
}

function setSys(on) {
  if (on === sysOn) return;
  sysOn = on;
  updateSysButton();
  if (on) {
    sysListener.resume();
    setTicker("…ожидание речи", false);
  } else {
    sysListener.pause();
    // Та же защита, что и для микрофона: снимаем залипший флаг речи «them».
    if (triggers) triggers.handleSpeechEnd("them");
    setTicker("собеседник не прослушивается — кнопка 🔊", false);
  }
}

document
  .getElementById("sys-toggle")
  .addEventListener("click", () => setSys(!sysOn));
updateSysButton();

// --- События из main process ---
// Ручной запрос голосовой подсказки (Cmd+Shift+P) — по диалогу.
window.ghostAPI.onForceHint(() => {
  if (!started) return;
  if (triggers) triggers.noteExternalRequest();
  requestHint("Ручной запрос", { force: true });
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

// Кнопки режима «решение задачи».
document
  .getElementById("shots-capture")
  .addEventListener("click", captureShot);
// Снимок области экрана по горячей клавише — Cmd+Shift+C.
window.ghostAPI.onCaptureShot(() => captureShot());
document.getElementById("shots-solve").addEventListener("click", solveShots);
renderShots(); // начальное состояние панели (кнопки выключены)

// Очистка ленты — кнопка 🗑.
document
  .getElementById("clear-btn")
  .addEventListener("click", clearConversation);

// --- Активация кнопок удержанием курсора ---
// Наводим курсор на кнопку и держим 3 сек — она срабатывает, как клик.
// Снизу бежит полоска-индикатор. Обычный клик тоже работает.
const DWELL_MS = 3000;
function setupDwell(btn) {
  let timer = null;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    btn.classList.remove("dwelling");
  };
  btn.addEventListener("mouseenter", () => {
    btn.classList.add("dwelling");
    timer = setTimeout(() => {
      timer = null;
      btn.classList.remove("dwelling");
      btn.click();
    }, DWELL_MS);
  });
  btn.addEventListener("mouseleave", cancel);
  btn.addEventListener("click", cancel); // обычный клик — отменяем удержание
}
// Постоянные кнопки панели; кнопки удаления снимков подключаются в renderShots.
document
  .querySelectorAll("#hint-controls button, #shots-capture, #shots-solve")
  .forEach(setupDwell);

// Кнопка «–» в шапке — свернуть оверлей в трей (вернуть — клик по иконке трея).
document
  .getElementById("hide-btn")
  .addEventListener("click", () => window.ghostAPI.hideOverlay());

// Кнопка × в шапке — полный выход из приложения.
document
  .getElementById("quit-btn")
  .addEventListener("click", () => window.ghostAPI.quitApp());

// --- Быстрая прозрачность фона — кнопки 100% / 0% ---
// Меняют только подложку: текст и кнопки рисуются поверх и остаются видны.
document
  .getElementById("opacity-full")
  .addEventListener("click", () => setPanelAlpha(1));
document
  .getElementById("opacity-low")
  .addEventListener("click", () => setPanelAlpha(0.2));

// --- Кнопка ⚙ — открыть окно настроек ---
// Точная настройка прозрачности и размер шрифта — там.
document
  .getElementById("settings-btn")
  .addEventListener("click", () => window.ghostAPI.openSettings());

// --- Проброс кликов сквозь ленту ответов ---
// Зона управления (шапка, кнопки, снимки, тикер) и ручки ресайза ловят клики.
// Над пустым местом ленты клики идут насквозь; над текстом ответа (.hint-msg)
// окно ловит мышь — чтобы можно было прокручивать и выделять текст.
const hintList = document.getElementById("hint-list");
const controlZone = [
  document.getElementById("hint-bar"),
  document.getElementById("hint-controls"),
  document.getElementById("shots-panel"),
  document.getElementById("ghost-ticker"),
];

let isClickThrough = false;
let resizing = false; // идёт ресайз окна — проброс кликов замораживаем

function setClickThrough(ignore) {
  if (ignore === isClickThrough) return;
  isClickThrough = ignore;
  window.ghostAPI.setClickThrough(ignore);
  hintList.classList.toggle("click-through", ignore);
}

document.addEventListener("mousemove", (e) => {
  if (resizing) return; // во время ресайза режим кликов не трогаем
  // Зона управления и ручки ресайза — клики нужны всегда.
  const overControls =
    controlZone.some((el) => el && el.contains(e.target)) ||
    e.target.closest(".rsz");
  if (overControls) {
    setClickThrough(false);
    return;
  }
  // Над текстом ответа ловим мышь (прокрутка, выделение);
  // над пустым местом ленты — пропускаем клики насквозь.
  setClickThrough(!e.target.closest(".hint-msg"));
});

// Курсор покинул окно — возвращаем обычный режим (клики ловятся).
document.addEventListener("mouseleave", () => {
  if (!resizing) setClickThrough(false);
});

// --- Изменение размеров окна за края и углы ---
// Невидимые ручки .rsz ловят mousedown и двигают границы окна через IPC.
// Сделано вручную, т.к. нативный ресайз перекрыт прозрачными краями,
// зоной перетаскивания шапки и пробросом кликов в ленте.
const RESIZE_MIN_W = 300;
const RESIZE_MIN_H = 220;

async function startResize(e, dir) {
  e.preventDefault();
  const start = await window.ghostAPI.getOverlayBounds();
  if (!start) return;
  resizing = true;
  setClickThrough(false); // на время ресайза окно ловит все события
  const sx = e.screenX;
  const sy = e.screenY;

  function onMove(ev) {
    const dx = ev.screenX - sx;
    const dy = ev.screenY - sy;
    let { x, y, width, height } = start;
    if (dir.includes("e")) width = start.width + dx;
    if (dir.includes("s")) height = start.height + dy;
    if (dir.includes("w")) {
      width = start.width - dx;
      x = start.x + dx;
    }
    if (dir.includes("n")) {
      height = start.height - dy;
      y = start.y + dy;
    }
    // Клампим по минимуму, фиксируя противоположный край.
    if (width < RESIZE_MIN_W) {
      if (dir.includes("w")) x = start.x + start.width - RESIZE_MIN_W;
      width = RESIZE_MIN_W;
    }
    if (height < RESIZE_MIN_H) {
      if (dir.includes("n")) y = start.y + start.height - RESIZE_MIN_H;
      height = RESIZE_MIN_H;
    }
    window.ghostAPI.setOverlayBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    });
  }

  function onUp() {
    resizing = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

document.querySelectorAll(".rsz").forEach((h) => {
  h.addEventListener("mousedown", (e) => startResize(e, h.dataset.dir));
});

// --- Применение изменённых настроек ---
window.ghostAPI.onSettingsUpdated(async () => {
  const apiKey = await loadConfig();
  applyPanelAlpha();
  applyHintFont();

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
