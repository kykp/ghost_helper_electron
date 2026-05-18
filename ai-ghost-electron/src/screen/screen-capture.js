// Захват экрана. Сам снимок и обрезку до области под окном оверлея делает
// main process (desktopCapturer) — здесь только тонкая обёртка над IPC.
class ScreenCapture {
  // Интерактивный снимок: пользователь выделяет область мышью.
  // Возвращает base64-строку JPEG либо null (если выделение отменено).
  async captureInteractive() {
    try {
      return await window.ghostAPI.captureInteractive();
    } catch (e) {
      console.warn("interactive capture failed:", e);
      return null;
    }
  }

  // Статус доступа к записи экрана (macOS): 'granted' | 'denied' | ...
  async access() {
    return await window.ghostAPI.screenAccess();
  }
}
