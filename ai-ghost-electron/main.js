// AI Ghost — main process.
// Невидимый overlay, скриншоты экрана, горячие клавиши, трей, прокси к OpenAI.

const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  screen,
  systemPreferences,
  session,
  nativeImage,
  protocol,
  net,
} = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");
const store = require("./src/utils/store");

let overlayWindow = null;
let settingsWindow = null;
let tray = null;

// ⭐ Свой протокол ghost://app/… вместо file://.
// VAD-движку (@ricky0123/vad-web + onnxruntime-web) нужно грузить ONNX-модель,
// wasm и audio-worklet через fetch()/addModule(). На file:// Chromium это
// блокирует; на обычном защищённом протоколе всё работает под CSP 'self'.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "ghost",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// --- Окно ассистента: обычное (рамка, перемещение, ресайз), невидимое для захвата экрана ---
function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const W = 460;
  const H = 520;

  overlayWindow = new BrowserWindow({
    width: W,
    height: H,
    minWidth: 300,
    minHeight: 220,
    x: width - W - 20, // правый верхний угол
    y: 60,
    title: "AI Ghost",
    backgroundColor: "#00000000", // прозрачное окно — фон рисует CSS-подложка
    transparent: true,
    frame: false, // безрамочное; перетаскивание — за шапку (CSS app-region)
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ⭐ Окно исключается из любого захвата экрана — трансляция и запись его не видят.
  overlayWindow.setContentProtection(true);
  // Поверх остальных окон, включая полноэкранные приложения.
  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.loadURL("ghost://app/src/overlay/overlay.html");

  // Прозрачность подложки регулируется в CSS (см. renderer) — не setOpacity,
  // чтобы текст оставался чётким при любом фоне.

  // Закрытие окна = полный выход (иконка из трея исчезает).
  overlayWindow.on("closed", () => app.quit());
}

// --- Окно настроек ---
function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 430,
    height: 600,
    resizable: false,
    title: "AI Ghost — Настройки",
    backgroundColor: "#15151f",
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ⭐ Окно настроек содержит API-ключ — исключаем его из захвата экрана,
  // как и оверлей. И поднимаем на тот же уровень, что оверлей, чтобы оно
  // открывалось поверх него, а не пряталось под ним.
  settingsWindow.setContentProtection(true);
  settingsWindow.setAlwaysOnTop(true, "screen-saver");
  settingsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  settingsWindow.loadURL("ghost://app/src/settings/settings.html");
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function notifyOverlay(channel) {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send(channel);
  }
}

// --- Запуск ---
app.whenReady().then(async () => {
  // Отдаём файлы приложения по ghost://app/<путь-от-корня-проекта>.
  protocol.handle("ghost", (request) => {
    const { pathname } = new URL(request.url);
    const filePath = path.join(__dirname, decodeURIComponent(pathname));
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Доступ к микрофону для overlay-окна.
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
    cb(perm === "media" || perm === "audioCapture");
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm) => {
    return perm === "media" || perm === "audioCapture";
  });

  // ⭐ Захват системного звука (голос собеседника в звонке).
  // getDisplayMedia в renderer попадает сюда; отдаём экран + loopback-аудио.
  // На macOS 13+ loopback идёт через ScreenCaptureKit — без стороннего ПО.
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          callback({ video: sources[0], audio: "loopback" });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );

  if (process.platform === "darwin") {
    try {
      await systemPreferences.askForMediaAccess("microphone");
    } catch (e) {
      /* пользователь решит позже */
    }
  }

  createOverlayWindow();

  // Горячие клавиши.
  globalShortcut.register("CommandOrControl+Shift+G", () => {
    if (!overlayWindow) return;
    if (overlayWindow.isVisible()) overlayWindow.hide();
    else overlayWindow.show();
  });
  globalShortcut.register("CommandOrControl+Shift+S", createSettingsWindow);
  globalShortcut.register("CommandOrControl+Shift+P", () =>
    notifyOverlay("force-hint")
  );
  globalShortcut.register("CommandOrControl+Shift+R", () =>
    notifyOverlay("repeat-question")
  );
  globalShortcut.register("CommandOrControl+Shift+M", () =>
    notifyOverlay("toggle-mic")
  );
  globalShortcut.register("CommandOrControl+Shift+Q", () => app.quit());

  // Иконка в трее.
  const trayIcon = nativeImage.createFromPath(
    path.join(__dirname, "assets", "trayTemplate.png")
  );
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip("AI Ghost");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Показать / скрыть оверлей",
        click: () => {
          if (!overlayWindow) return;
          if (overlayWindow.isVisible()) overlayWindow.hide();
          else overlayWindow.show();
        },
      },
      {
        label: "Микрофон вкл/выкл",
        click: () => notifyOverlay("toggle-mic"),
      },
      {
        label: "Принудительная подсказка (со скриншотом)",
        click: () => notifyOverlay("force-hint"),
      },
      {
        label: "Переспросить (повтор распознавания)",
        click: () => notifyOverlay("repeat-question"),
      },
      { label: "Настройки…", click: createSettingsWindow },
      { type: "separator" },
      { label: "Выход", click: () => app.quit() },
    ])
  );

  // Прячем приложение из дока macOS — управление через трей и хоткеи.
  if (process.platform === "darwin" && app.dock) app.dock.hide();
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (tray && !tray.isDestroyed()) tray.destroy(); // убираем иконку из трея
});

// --- IPC: скриншот области под окном оверлея ---
// Оверлей исключён из захвата (setContentProtection), поэтому снимок
// показывает то, что под ним — задачу на экране, а не само окно.
ipcMain.handle("capture-region", async () => {
  try {
    if (!overlayWindow || overlayWindow.isDestroyed()) return null;

    // Прямоугольник контента окна в экранных координатах (DIP).
    const region = overlayWindow.getContentBounds();
    const display = screen.getDisplayMatching(region);
    const scale = display.scaleFactor;

    // Снимаем дисплей в нативном разрешении — чтобы код на экране был
    // читаем для GPT (detail: "high" даёт прочитать мелкий текст).
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      },
    });
    const src =
      sources.find((s) => String(s.display_id) === String(display.id)) ||
      sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;

    // Прямоугольник окна внутри дисплея, в нативных пикселях.
    const full = src.thumbnail.getSize();
    let x = Math.round((region.x - display.bounds.x) * scale);
    let y = Math.round((region.y - display.bounds.y) * scale);
    let w = Math.round(region.width * scale);
    let h = Math.round(region.height * scale);
    // Подрезаем по границам кадра.
    x = Math.max(0, Math.min(x, full.width - 1));
    y = Math.max(0, Math.min(y, full.height - 1));
    w = Math.max(1, Math.min(w, full.width - x));
    h = Math.max(1, Math.min(h, full.height - y));

    const cropped = src.thumbnail.crop({ x, y, width: w, height: h });
    if (cropped.isEmpty()) return null;
    return cropped.toJPEG(85).toString("base64");
  } catch (e) {
    console.error("capture-region:", e);
    return null;
  }
});

ipcMain.handle("screen-access", () => {
  if (process.platform !== "darwin") return "granted";
  return systemPreferences.getMediaAccessStatus("screen");
});

// --- IPC: настройки ---
ipcMain.handle("get-api-key", () => store.get("openai-api-key"));
ipcMain.handle("set-api-key", (e, key) => {
  store.set("openai-api-key", key || "");
  notifyOverlay("settings-updated");
});
ipcMain.handle("get-settings", () => store.get("settings"));
ipcMain.handle("set-settings", (e, s) => {
  store.set("settings", s);
  notifyOverlay("settings-updated"); // прозрачность подложки применит renderer
});

// --- IPC: OpenAI (через main, чтобы не упираться в CORS) ---

// fetch с таймаутом: без него зависший запрос навсегда оставляет оверлей
// в статусе «думаю…» (await не завершается), и весь UI перестаёт отвечать.
async function fetchWithTimeout(url, options, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle("openai-chat", async (e, { apiKey, body }) => {
  try {
    // Решение задач по скриншотам идёт reasoning-моделью — даём ей время.
    const resp = await fetchWithTimeout(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(body),
      },
      150000
    );
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        error: (data.error && data.error.message) || "Ошибка API " + resp.status,
        status: resp.status,
      };
    }
    return { data };
  } catch (err) {
    return {
      error:
        err && err.name === "AbortError"
          ? "OpenAI не ответил вовремя — попробуйте ещё раз."
          : "Нет связи с OpenAI API.",
    };
  }
});

// Стриминг чата — ответ отдаётся по мере генерации (для голосовых
// подсказок: важна скорость появления текста). Дельты летят в renderer
// событиями «openai-chat-delta», в конце — «openai-chat-end».
ipcMain.on("openai-chat-stream", async (e, { apiKey, body }) => {
  const wc = e.sender;
  const send = (channel, payload) => {
    if (!wc.isDestroyed()) wc.send(channel, payload);
  };
  // Сторожевой таймер: прерываем запрос, если данных нет дольше 45 сек —
  // иначе зависшее соединение навсегда оставит оверлей в статусе «думаю…».
  const ac = new AbortController();
  let idleTimer = null;
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ac.abort(), 45000);
  };
  try {
    armIdle();
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal: ac.signal,
    });
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      send("openai-chat-end", {
        error:
          (data.error && data.error.message) || "Ошибка API " + resp.status,
      });
      return;
    }

    // SSE: строки «data: {…}», копим полный текст ответа.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle(); // данные пришли — перезапускаем сторожевой таймер
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // последняя строка может быть неполной
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          const delta =
            json.choices &&
            json.choices[0] &&
            json.choices[0].delta &&
            json.choices[0].delta.content;
          if (delta) {
            full += delta;
            send("openai-chat-delta", delta);
          }
        } catch (err) {
          /* служебный/неполный фрагмент — пропускаем */
        }
      }
    }
    send("openai-chat-end", { text: full });
  } catch (err) {
    send("openai-chat-end", {
      error:
        err && err.name === "AbortError"
          ? "OpenAI не ответил вовремя — попробуйте ещё раз."
          : "Нет связи с OpenAI API.",
    });
  } finally {
    clearTimeout(idleTimer);
  }
});

ipcMain.handle(
  "openai-transcribe",
  async (e, { apiKey, audio, mime, language, prompt }) => {
    try {
      const form = new FormData();
      form.append(
        "file",
        new Blob([audio], { type: mime || "audio/wav" }),
        "audio.wav"
      );
      form.append("model", "gpt-4o-mini-transcribe");
      if (language) form.append("language", language);
      // ⭐ Контекстная подсказка — резко улучшает распознавание тех. терминов.
      if (prompt) form.append("prompt", prompt);

      const resp = await fetchWithTimeout(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: "Bearer " + apiKey },
          body: form,
        },
        60000
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          error: (data.error && data.error.message) || "Ошибка STT " + resp.status,
        };
      }
      return { text: (data.text || "").trim() };
    } catch (err) {
      return {
        error:
          err && err.name === "AbortError"
            ? "Распознавание не успело — попробуйте ещё раз."
            : "Нет связи с OpenAI API.",
      };
    }
  }
);

// Проверка ключа — лёгкий запрос без расхода токенов.
ipcMain.handle("test-api-key", async (e, key) => {
  try {
    const resp = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer " + (key || "") },
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 401) return { ok: false, error: "Неверный ключ" };
    return { ok: false, error: "HTTP " + resp.status };
  } catch (err) {
    return { ok: false, error: "Нет связи" };
  }
});

// Шестерёнка ⚙ в оверлее — открыть окно настроек.
ipcMain.on("open-settings", createSettingsWindow);

ipcMain.on("close-settings", () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});

// Кнопка × в безрамочном оверлее — полный выход.
ipcMain.on("quit-app", () => app.quit());

// --- IPC: проброс кликов сквозь ленту ответов ---
// renderer включает режим, когда курсор над пустым местом ленты: клики уходят
// в окно под оверлеем. { forward: true } обязателен — без него окно перестаёт
// получать mousemove и не заметит возврат курсора на интерактивный элемент.
ipcMain.on("set-click-through", (e, ignore) => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setIgnoreMouseEvents(!!ignore, { forward: true });
  }
});

// --- IPC: изменение размеров окна оверлея ручками .rsz ---
ipcMain.handle("get-overlay-bounds", () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return null;
  return overlayWindow.getBounds();
});
ipcMain.on("set-overlay-bounds", (e, b) => {
  if (overlayWindow && !overlayWindow.isDestroyed() && b) {
    overlayWindow.setBounds(b);
  }
});
