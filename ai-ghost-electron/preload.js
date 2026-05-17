// AI Ghost — preload: безопасный мост renderer ↔ main (для обоих окон).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ghostAPI", {
  // Экран
  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  screenAccess: () => ipcRenderer.invoke("screen-access"),
  // Настройки
  getApiKey: () => ipcRenderer.invoke("get-api-key"),
  setApiKey: (key) => ipcRenderer.invoke("set-api-key", key),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  setSettings: (s) => ipcRenderer.invoke("set-settings", s),
  testApiKey: (key) => ipcRenderer.invoke("test-api-key", key),
  // OpenAI
  chat: (apiKey, body) => ipcRenderer.invoke("openai-chat", { apiKey, body }),
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
  // Управление окном настроек
  closeSettings: () => ipcRenderer.send("close-settings"),
});
