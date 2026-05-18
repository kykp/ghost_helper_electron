// AI Ghost — preload: безопасный мост renderer ↔ main (для обоих окон).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ghostAPI", {
  // Экран
  captureRegion: () => ipcRenderer.invoke("capture-region"),
  screenAccess: () => ipcRenderer.invoke("screen-access"),
  // Настройки
  getApiKey: () => ipcRenderer.invoke("get-api-key"),
  setApiKey: (key) => ipcRenderer.invoke("set-api-key", key),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (s) => ipcRenderer.invoke("set-settings", s),
  testApiKey: (key) => ipcRenderer.invoke("test-api-key", key),
  // OpenAI
  chat: (apiKey, body) => ipcRenderer.invoke("openai-chat", { apiKey, body }),
  // Стриминг чата: запуск + подписка на дельты и завершение
  chatStream: (apiKey, body) =>
    ipcRenderer.send("openai-chat-stream", { apiKey, body }),
  onChatStreamDelta: (cb) =>
    ipcRenderer.on("openai-chat-delta", (e, delta) => cb(delta)),
  onChatStreamEnd: (cb) =>
    ipcRenderer.on("openai-chat-end", (e, payload) => cb(payload)),
  transcribe: (apiKey, audio, mime, language, prompt) =>
    ipcRenderer.invoke("openai-transcribe", {
      apiKey,
      audio,
      mime,
      language,
      prompt,
    }),
  // События из main
  onForceHint: (cb) => ipcRenderer.on("force-hint", () => cb()),
  onRepeatQuestion: (cb) => ipcRenderer.on("repeat-question", () => cb()),
  onSettingsUpdated: (cb) => ipcRenderer.on("settings-updated", () => cb()),
  onToggleMic: (cb) => ipcRenderer.on("toggle-mic", () => cb()),
  // Управление окнами
  openSettings: () => ipcRenderer.send("open-settings"),
  closeSettings: () => ipcRenderer.send("close-settings"),
  quitApp: () => ipcRenderer.send("quit-app"),
  // Проброс кликов: ignore=true → клики проходят сквозь оверлей
  setClickThrough: (ignore) => ipcRenderer.send("set-click-through", ignore),
  // Изменение размеров окна ручками .rsz
  getOverlayBounds: () => ipcRenderer.invoke("get-overlay-bounds"),
  setOverlayBounds: (b) => ipcRenderer.send("set-overlay-bounds", b),
});
