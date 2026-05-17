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
    backgroundColor: "#15151f",
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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
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

// Приложение живёт в трее — не закрываем при закрытии окон.
app.on("window-all-closed", () => {});
app.on("will-quit", () => globalShortcut.unregisterAll());

// --- IPC: захват экрана ---
ipcMain.handle("capture-screen", async () => {
  try {
    const primary = screen.getPrimaryDisplay();
    // Снимаем в реальном разрешении дисплея — чтобы код на экране был
    // читаемым для GPT (с detail: "high" модель видит мелкий текст).
    const { width, height } = primary.size;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });
    const src =
      sources.find((s) => String(s.display_id) === String(primary.id)) ||
      sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return src.thumbnail.toJPEG(80).toString("base64");
  } catch (e) {
    console.error("capture-screen:", e);
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
  notifyOverlay("settings-updated");
});

// --- IPC: OpenAI (через main, чтобы не упираться в CORS) ---
ipcMain.handle("openai-chat", async (e, { apiKey, body }) => {
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return {
        error: (data.error && data.error.message) || "Ошибка API " + resp.status,
        status: resp.status,
      };
    }
    return { data };
  } catch (err) {
    return { error: "Нет связи с OpenAI API." };
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

      const resp = await fetch(
        "https://api.openai.com/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: "Bearer " + apiKey },
          body: form,
        }
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        return {
          error: (data.error && data.error.message) || "Ошибка STT " + resp.status,
        };
      }
      return { text: (data.text || "").trim() };
    } catch (err) {
      return { error: "Нет связи с OpenAI API." };
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

ipcMain.on("close-settings", () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
});
