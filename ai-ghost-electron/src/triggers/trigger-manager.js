// Координатор триггеров + антиспам.
// Решает, КОГДА и ПОЧЕМУ отправлять голосовой запрос в GPT, с учётом того,
// кто говорил последним — я или собеседник.
//
// Логика:
//   • Вопрос (от собеседника ИЛИ озвученный мной) → ждать 2 сек → запрос
//   • Собеседник сменил тему   → ждать 4 сек тишины → запрос
//   • Я отвечаю своими словами → отменить отложенный триггер
//   • Тишина после вопроса >5с → срочный запрос (я завис)
//   • Антиспам: минимум N сек между запросами, максимум 5 в минуту
//
// Вопрос засчитывается и в моей речи — на случай, когда собеседник прислал
// вопрос текстом, а я читаю его вслух.
class TriggerManager {
  constructor(opts = {}) {
    this.minInterval = (opts.minIntervalSec ?? 10) * 1000;
    this.maxPerMinute = 5;
    this.questionDelayMs = 800; // пауза после вопроса
    this.topicDelayMs = 4000; // пауза после смены темы
    this.silenceAfterQuestionMs = (opts.silenceThresholdSec ?? 5) * 1000;

    this.onTrigger = null; // callback(reason)

    this.question = new QuestionTrigger();
    this.topic = new TopicTrigger();

    // Антиспам
    this.lastRequestTime = 0;
    this.requestCount = 0;
    this.windowStart = Date.now();

    // Состояние разговора
    this.lastSpeaker = null; // 'me' | 'them'
    this.speaking = { me: false, them: false }; // кто сейчас говорит
    this.lastSpeechEndTime = Date.now();
    this.pending = null; // { reason, delayMs }
    this.openQuestion = null; // { time } — вопрос собеседника без моего ответа
    this.urgentFired = false; // срочный запрос по этому вопросу уже был
  }

  setMinInterval(sec) {
    this.minInterval = sec * 1000;
  }
  setSilenceThreshold(sec) {
    this.silenceAfterQuestionMs = sec * 1000;
  }

  // --- Входящие события речи ---

  handleSpeechStart(source) {
    this.speaking[source] = true;
    // Я заговорил — значит отвечаю сам, отложенная подсказка не нужна.
    if (source === "me") {
      this.pending = null;
      this.openQuestion = null;
    }
  }

  handleSpeechEnd(source) {
    this.speaking[source] = false;
    // Тишину отсчитываем только когда замолчали оба источника.
    if (!this.speaking.me && !this.speaking.them) {
      this.lastSpeechEndTime = Date.now();
    }
  }

  get anyoneSpeaking() {
    return this.speaking.me || this.speaking.them;
  }

  // Распознанная реплика целиком.
  handleUtterance({ source, text }) {
    this.lastSpeaker = source;
    const now = Date.now();

    if (this.question.test(text)) {
      // Вопрос задан собеседником вслух ИЛИ озвучен мной (например, прочитан
      // из текстового чата) — в обоих случаях нужна подсказка.
      if (source === "them") {
        // Срочный «я завис» отслеживаем только для вопросов собеседника.
        this.openQuestion = { time: now };
        this.urgentFired = false;
      }
      const reason =
        source === "them" ? "Вопрос собеседника" : "Вопрос (ваш голос)";
      this._schedule(reason, this.questionDelayMs);
      return;
    }

    // Не вопрос.
    if (source === "me") {
      // Я отвечаю своими словами — отложенная подсказка не нужна.
      this.pending = null;
      this.openQuestion = null;
    }
    // Собеседник продолжает не-вопросом — просто копим буфер; паузу
    // отложенного триггера lastSpeechEndTime отсчитает заново сам.
  }

  // Периодическая проверка смены темы (вызывается по таймеру из overlay).
  checkTopicChange(recentText, previousText) {
    if (this.lastSpeaker !== "them") return;
    if (this.pending && this.pending.reason === "Вопрос собеседника") return;
    if (this.topic.check(recentText, previousText)) {
      this._schedule("Смена темы разговора", this.topicDelayMs);
    }
  }

  // Тик ~раз в 0.5 сек — реализует отложенные и срочные срабатывания.
  tick() {
    const now = Date.now();
    if (this.anyoneSpeaking) return;
    const silenceMs = now - this.lastSpeechEndTime;

    // Отложенный триггер: пора, если выждали нужную паузу.
    if (this.pending && silenceMs >= this.pending.delayMs) {
      if (this._fire(this.pending.reason)) {
        this.pending = null;
      }
      return;
    }

    // Срочный запрос: вопрос собеседника висит, я молчу дольше порога.
    if (
      this.openQuestion &&
      !this.urgentFired &&
      this.lastSpeaker === "them" &&
      silenceMs >= this.silenceAfterQuestionMs
    ) {
      if (this._fire("Тишина после вопроса")) {
        this.urgentFired = true;
      }
    }
  }

  // Внешний (ручной) запрос прошёл — сдвигаем окно антиспама,
  // чтобы авто-триггер не выстрелил сразу следом.
  noteExternalRequest() {
    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  // --- Внутреннее ---

  _schedule(reason, delayMs) {
    this.pending = { reason, delayMs };
  }

  // Антиспам + вызов колбэка.
  _fire(reason) {
    const now = Date.now();

    if (now - this.lastRequestTime < this.minInterval) {
      console.log(`⏳ Триггер «${reason}» отложен (антиспам)`);
      return false; // pending останется — выстрелит в следующем окне
    }
    if (now - this.windowStart > 60000) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    if (this.requestCount >= this.maxPerMinute) {
      console.log(`🚫 Триггер «${reason}» отклонён (лимит в минуту)`);
      return false;
    }

    this.lastRequestTime = now;
    this.requestCount++;
    console.log(`🔥 Триггер: ${reason}`);
    if (this.onTrigger) this.onTrigger(reason);
    return true;
  }
}
