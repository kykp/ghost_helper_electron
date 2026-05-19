// Триггер 2 — обнаружен вопрос.
// Реагирует на «?» либо на фразу, начинающуюся с вопросительных слов.
class QuestionTrigger {
  constructor() {
    this.patterns = [
      /\?/,
      /^(как|почему|зачем|сколько|когда|где|кто|что|какой|каков|какие|чем|расскажи)/i,
      /^(можете|можешь|могли бы|расскажите|опишите|объясните|поясните)/i,
      /^(напиши|реализуй|сделай|реши|посчитай|найди|сравни|приведи|перечисли|покажи|дай|давай|нужно|надо)/i,
      /^(what|why|how|when|where|who|which|can you|could you|would you|tell me|describe|explain)/i,
    ];
  }

  test(text) {
    const t = (text || "").trim();
    if (!t) return false;
    return this.patterns.some((p) => p.test(t));
  }
}
