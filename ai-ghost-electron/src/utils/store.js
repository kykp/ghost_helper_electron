// Хранилище настроек (main process). Значения лежат в electron-store,
// API-ключ — с обфускацией через encryptionKey.
const Store = require("electron-store");

const store = new Store({
  encryptionKey: "ai-ghost-secret",
  defaults: {
    "openai-api-key": "",
    settings: {
      lang: "ru", // язык распознавания речи
      minInterval: 10, // мин. интервал между запросами в GPT, сек (антиспам)
      silenceThreshold: 5, // тишина после вопроса → срочная подсказка, сек
      fontSize: 20, // размер шрифта в ленте ответов, px
    },
  },
});

module.exports = store;
