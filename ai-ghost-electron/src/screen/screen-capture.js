// Захват экрана. Сам снимок и сжатие в JPEG/base64 делает main process
// (desktopCapturer) — здесь только тонкая обёртка над IPC.
class ScreenCapture {
  // Возвращает base64-строку JPEG (без префикса data:) либо null.
  async capture() {
    try {
      return await window.ghostAPI.captureScreen();
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
