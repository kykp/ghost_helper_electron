// Захват экрана. Сам снимок делает main process — здесь только обёртка над IPC.
class ScreenCapture {
  // Снимок всего главного экрана. Модель сама найдёт вопрос/задачу в кадре.
  // Возвращает base64-строку JPEG либо null (если снимок не удался).
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
