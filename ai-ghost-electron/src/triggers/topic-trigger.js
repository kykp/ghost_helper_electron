// Триггер 3 — смена темы.
// Сравнивает ключевые слова двух соседних отрезков разговора.
// Если пересечение < порога — считаем, что тема сменилась.
class TopicTrigger {
  constructor(threshold = 0.2) {
    this.threshold = threshold;
    this.stopWords = new Set([
      "и", "в", "во", "на", "с", "со", "по", "для", "это", "что", "как",
      "не", "но", "а", "о", "об", "из", "к", "у", "за", "от", "до", "же",
      "ну", "вот", "там", "так", "бы", "ли", "да", "нет", "the", "a", "an",
      "is", "are", "was", "were", "to", "in", "on", "for", "and", "or",
      "but", "of", "it", "this", "that", "with", "you", "i",
    ]);
  }

  keywords(text) {
    return new Set(
      (text || "")
        .toLowerCase()
        .replace(/[^\p{L}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !this.stopWords.has(w))
    );
  }

  // Вернёт true, если тема сменилась.
  check(recentText, previousText) {
    const recent = this.keywords(recentText);
    const previous = this.keywords(previousText);
    if (recent.size < 3 || previous.size < 3) return false;

    const intersection = [...recent].filter((w) => previous.has(w)).length;
    const overlap = intersection / Math.max(recent.size, previous.size);
    return overlap < this.threshold;
  }
}
