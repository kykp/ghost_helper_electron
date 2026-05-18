// Захват экрана. Сам снимок и обрезку до области под окном оверлея делает
// main process (desktopCapturer) — здесь только тонкая обёртка над IPC.
class ScreenCapture {
  // Скриншот области экрана под окном оверлея.
  // Возвращает base64-строку JPEG (без префикса data:) либо null.
  async captureRegion() {
    try {
      return await window.ghostAPI.captureRegion();
    } catch (e) {
      console.warn("capture failed:", e);
      return null;
    }
  }

  // Статус доступа к записи экрана (macOS): 'granted' | 'denied' | ...
  async access() {
    return await window.ghostAPI.screenAccess();
  }
}
