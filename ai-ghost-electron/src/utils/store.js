// Хранилище настроек (main process). Значения лежат в electron-store,
// API-ключ — с обфускацией через encryptionKey.
const Store = require("electron-store");

const store = new Store({
  encryptionKey: "ai-ghost-secret",
  defaults: {
    "openai-api-key": "",
    "overlay-bounds": null, // { x, y, width, height } — размер/позиция окна
    settings: {
      lang: "ru", // язык распознавания речи
      minInterval: 3, // мин. интервал между запросами в GPT, сек (антиспам)
      pauseSec: 2, // пауза в речи перед запросом, сек
      maxWaitSec: 7, // pending дольше этого → force-fire без паузы, сек
      opacity: 0.72, // плотность тёмной подложки оверлея, 0.3–1
      fontSize: 20, // размер шрифта в ленте ответов, px
    },
  },
});

module.exports = store;
