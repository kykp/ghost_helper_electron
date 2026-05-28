// Координатор триггеров — единое правило для обоих микрофонов.
//
// Логика:
//   • Любая реплика (моя или собеседника) ставит «pending» — нужен запрос.
//   • Когда оба молчат дольше `pauseMs` И в данный момент не идёт запрос,
//     pending выстреливает: отправляем диалог в GPT.
//   • Если pending висит дольше `maxWaitMs` (собеседник трещит без пауз) —
//     стреляем принудительно даже посреди речи. Дальше при следующей паузе
//     уйдёт follow-up с дополнившимся контекстом.
//   • Если во время полёта запроса пришла новая речь — pending снова
//     взводится; следующий запрос уйдёт сразу после ответа + паузы.
//   • Контекст между запросами не теряется: TranscriptBuffer накапливает
//     реплики, а OpenAIClient.recentHints подмешивает прошлые ответы —
//     модель видит, что уже сказала, и дополняет, а не повторяет.
//   • Антиспам: новый текст должен появиться после прошлого запроса
//     (иначе ответили бы повторно на одно и то же), плюс минимум
//     `minInterval` между запросами и максимум `maxPerMinute` в минуту.
class TriggerManager {
  constructor(opts = {}) {
    this.pauseMs = (opts.pauseSec ?? 2) * 1000;
    this.maxWaitMs = (opts.maxWaitSec ?? 7) * 1000;
    this.minInterval = (opts.minIntervalSec ?? 3) * 1000;
    this.maxPerMinute = 12;

    this.onTrigger = null; // callback(reason)

    // Антиспам
    this.lastRequestTime = 0;
    this.requestCount = 0;
    this.windowStart = Date.now();

    // Состояние разговора
    this.speaking = { me: false, them: false };
    this.lastSpeechEndTime = Date.now();
    this.pendingReason = null; // имя источника последней реплики или null
    this.pendingSince = 0; // когда pending впервые взвели (для force-fire)
    this.lastUtteranceTime = 0; // когда пришла последняя реплика
    this.requesting = false; // запрос в полёте — следующий ждёт
  }

  setPause(sec) {
    this.pauseMs = sec * 1000;
  }
  setMaxWait(sec) {
    this.maxWaitMs = sec * 1000;
  }
  setMinInterval(sec) {
    this.minInterval = sec * 1000;
  }

  // Идёт ли сейчас запрос в GPT — выставляется из overlay.js.
  setRequesting(busy) {
    this.requesting = !!busy;
  }

  // Сброс состояния — после очистки беседы.
  reset() {
    this.pendingReason = null;
    this.pendingSince = 0;
    this.lastUtteranceTime = 0;
  }

  // --- Входящие события речи ---

  handleSpeechStart(source) {
    this.speaking[source] = true;
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

  // Распознанная реплика — просто отмечаем, что есть свежий материал.
  handleUtterance({ source, text }) {
    if (!text) return;
    const now = Date.now();
    this.lastUtteranceTime = now;
    // pendingSince взводим только при переходе из «нет pending» в «есть»,
    // чтобы force-fire по таймауту считал от ПЕРВОЙ непрожатой реплики.
    if (!this.pendingReason) this.pendingSince = now;
    this.pendingReason = source === "me" ? "Ваша речь" : "Речь собеседника";
  }

  // Внешний (ручной) запрос прошёл — сдвигаем окно антиспама.
  noteExternalRequest() {
    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  // Тик ~раз в 250 мс — реализует отложенное срабатывание.
  tick() {
    if (!this.pendingReason) return;
    if (this.requesting) return; // ждём завершения текущего запроса

    const now = Date.now();
    // Force-fire по таймауту: собеседник трещит без пауз ≥ pauseMs,
    // pending висит дольше maxWaitMs — стреляем посреди речи.
    const forceFire = now - this.pendingSince >= this.maxWaitMs;
    if (!forceFire) {
      if (this.anyoneSpeaking) return;
      if (now - this.lastSpeechEndTime < this.pauseMs) return;
    }

    // Антидубль: новый текст должен быть позже момента прошлого запроса.
    if (this.lastUtteranceTime <= this.lastRequestTime) {
      this.pendingReason = null;
      this.pendingSince = 0;
      return;
    }

    // Антиспам по интервалу — ждём, не сбрасывая pending.
    if (now - this.lastRequestTime < this.minInterval) return;

    // Антиспам по лимиту в минуту.
    if (now - this.windowStart > 60000) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    if (this.requestCount >= this.maxPerMinute) {
      console.log("🚫 Триггер отклонён (лимит в минуту)");
      this.pendingReason = null;
      this.pendingSince = 0;
      return;
    }

    const baseReason = this.pendingReason;
    const reason = forceFire ? `${baseReason} (без паузы)` : baseReason;
    this.pendingReason = null;
    this.pendingSince = 0;
    this.lastRequestTime = now;
    this.requestCount++;
    console.log(`🔥 Триггер: ${reason}`);
    if (this.onTrigger) this.onTrigger(reason);
  }
}
