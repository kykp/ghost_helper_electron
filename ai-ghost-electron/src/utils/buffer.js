// Буфер диалога — хранит реплики за последние N мс с пометкой источника.
// Каждая запись: { text, source: 'me' | 'them', timestamp }.
// Загружается как обычный <script>, класс доступен глобально.
class TranscriptBuffer {
  constructor(maxAge = 180000) {
    this.entries = [];
    this.maxAge = maxAge;
  }

  // source: 'me' (мой голос) | 'them' (голос собеседника).
  add(text, source = "them") {
    if (!text) return;
    this.entries.push({ text, source, timestamp: Date.now() });
    this.cleanup();
  }

  // Диалог за последние `seconds` секунд в формате для GPT:
  //   Собеседник: ...
  //   Я: ...
  // Подряд идущие реплики одного источника склеиваются в одну строку.
  getDialog(seconds = 60) {
    const cutoff = Date.now() - seconds * 1000;
    const lines = [];
    for (const e of this.entries) {
      if (e.timestamp <= cutoff) continue;
      const label = e.source === "me" ? "Я" : "Собеседник";
      const last = lines[lines.length - 1];
      if (last && last.label === label) last.text += " " + e.text;
      else lines.push({ label, text: e.text });
    }
    return lines.map((l) => `${l.label}: ${l.text}`).join("\n");
  }

  // Последняя реплика (или null).
  last() {
    return this.entries[this.entries.length - 1] || null;
  }

  // Сырой текст за последние `seconds` секунд (без меток источника).
  getRecent(seconds = 30) {
    const cutoff = Date.now() - seconds * 1000;
    return this.entries
      .filter((e) => e.timestamp > cutoff)
      .map((e) => e.text)
      .join(" ");
  }

  // Текст в диапазоне «от olderSec назад до newerSec назад» — для смены темы.
  getRange(olderSec, newerSec) {
    const now = Date.now();
    const from = now - olderSec * 1000;
    const to = now - newerSec * 1000;
    return this.entries
      .filter((e) => e.timestamp > from && e.timestamp <= to)
      .map((e) => e.text)
      .join(" ");
  }

  cleanup() {
    const cutoff = Date.now() - this.maxAge;
    this.entries = this.entries.filter((e) => e.timestamp > cutoff);
  }

  clear() {
    this.entries = [];
  }
}
