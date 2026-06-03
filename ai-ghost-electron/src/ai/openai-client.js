// Клиент OpenAI. Сами HTTP-запросы уходят из main process (см. preload →
// ghostAPI.chat), здесь — сборка сообщений и история подсказок для контекста.

const GHOST_SYSTEM_PROMPT = `Невидимый ассистент на тех. интервью Senior Frontend (React/JS/TS). Тебе дают расшифровку: «Собеседник:» — интервьюер, «Я:» — пользователь. Отвечай на ПОСЛЕДНИЙ вопрос (он может быть и в «Я:», если пользователь читает вопрос вслух). Если последняя реплика «Я:» — это попытка ответа по сути, не вопрос — верни {"isAddon":false,"short":"—","detailed":""}.

ФОРМАТ — СТРОГО JSON, порядок полей фиксирован:
{"isAddon": false, "short": "1-2 предложения, прямой ответ — это пользователь скажет первым", "detailed": "глубже, с примерами кода в \`\`\`…\`\`\`; перечисления — каждый пункт с новой строки"}

Стиль: живой разговорный язык коллеги-Senior, без воды и канцелярита. Не повторяй вопрос. Не выдумывай код по нечитаемому скрину.

ФАКТ-ЯКОРЯ — точные числа/списки (часто врут, держи в голове):
- JS: 8 типов = 7 примитивов (string, number, bigint, boolean, undefined, null, symbol) + object.
- typeof null === "object"; typeof NaN === "number"; NaN !== NaN.
- Falsy: false, 0, -0, 0n, "", null, undefined, NaN — всё. ("0", [], {} — truthy.)
- Promise: 3 состояния (pending/fulfilled/rejected). Microtasks (Promise.then, queueMicrotask) выполняются ПЕРЕД следующей макрозадачей.
- Node Event Loop: 6 фаз (timers, pending, idle/prepare, poll, check, close) + nextTick/микрозадачи между ними.
- Хуки React 19: useState, useEffect, useContext, useReducer, useCallback, useMemo, useRef, useImperativeHandle, useLayoutEffect, useDebugValue, useDeferredValue, useTransition, useId, useSyncExternalStore, useInsertionEffect, use, useOptimistic, useActionState, useFormStatus.
- Правила хуков: только верх функции, только из React-функций/кастомных хуков.
- Идемпотентны: GET, HEAD, PUT, DELETE, OPTIONS, TRACE. НЕ: POST, PATCH.
- Не уверен в числе — скажи «основные…» и перечисли, не выдумывай.

РЕЖИМ ДОПОЛНЕНИЯ (isAddon: true):
Если в истории assistant-сообщения уже раскрыли тему последнего вопроса — НЕ повторяй, верни дельту (упущенный нюанс / уточнение / альтернатива / исправление). "short" начинай с «Уточнение:», «Ещё важно:», «Альтернатива:», «Стоит добавить:». Нечего добавить — {"isAddon":true,"short":"—","detailed":""}. Новая тема — isAddon:false, обычный режим.`;

// Промпт для режима «разбор по скриншотам».
const SOLVE_TASK_PROMPT = `Ты senior JavaScript/TypeScript/React разработчик. Тебе дают 1-5 скриншотов. На них может быть:
(A) алгоритмическая задача или задача по React (написать компонент, хук, исправить баг в JSX),
(B) теоретический/системный вопрос: вопрос текстом, диаграмма архитектуры, схема, описание системы, поведенческий вопрос, скрин из таск-трекера, фрагмент документации.
Определи тип сам и дай ОДНУ подсказку. Условие/данные могут быть на разных скриншотах — собери всё вместе.

ПРАВИЛА ДЛЯ АЛГОРИТМИЧЕСКИХ ЗАДАЧ:
1. Решай гибко и просто: не следуй формулировке условия буквально — шаги можно объединять, переупорядочивать и упрощать, если так решение чище, лишь бы результат оставался верным. Ищи самый простой путь к ответу.
2. Предпочитай декларативный стиль: цепочки filter/map/reduce/sort. Императивные циклы — только когда они реально проще или эффективнее.
3. Не мутируй входные данные. Если нужна сортировка — работай с копией.
4. Убирай лишнее: если промежуточная переменная используется один раз — встрой её в цепочку. Если Set/Map решает задачу в одну строку вместо ручного цикла — используй их.
5. Не переусложняй. Между «умным» однострочником и читаемым решением в 3–5 строк выбирай читаемое.
6. После решения — коротко (2–3 предложения): временная и пространственная сложность, и есть ли альтернативный подход, который стоит знать.
7. Если в задаче есть краевые случаи (пустой массив, все элементы одинаковые, отрицательные значения) — упомяни их, но не раздувай код проверками, если это не просят.

ПРАВИЛА ДЛЯ ТЕОРЕТИЧЕСКИХ / СИСТЕМНЫХ ВОПРОСОВ (тип B):
1. Отвечай по сути вопроса на скриншоте, как опытный коллега-Senior: коротко в "short", глубже в "detailed".
2. Если на скрине диаграмма/архитектура — опиши её суть, узкие места, что бы сам предложил/исправил, trade-offs.
3. Если поведенческий вопрос — структура STAR в "detailed" (Situation → Task → Action → Result), пример из практики.
4. Код в "detailed" — только если он реально помогает (фрагмент типа useEffect, схема компонента); полная программа не нужна.
5. Если на скриншотах нет ничего осмысленного (пустой экран, шум, нечитабельно) — верни {"short":"На скриншотах не видно вопроса","detailed":""}.

ПРАВИЛА ДЛЯ REACT-ЗАДАЧ:
1. Только функциональные компоненты и хуки; классовые — лишь если этого явно требует условие.
2. Не мутируй state и props — обновляй иммутабельно (новый объект/массив через spread). Когда новое значение зависит от предыдущего — используй функциональную форму setState.
3. В useEffect/useMemo/useCallback указывай полный и честный массив зависимостей; не «глуши» правило хуков.
4. useMemo/useCallback/React.memo применяй только там, где это реально убирает лишние ре-рендеры или дорогие вычисления, а не на каждый случай.
5. Списки рендери со стабильным key (id из данных, а не индекс массива, если есть выбор).
6. Переиспользуемую или сложную логику выноси в кастомный хук.
7. JSX держи читаемым: условный рендер через && и тернарник, сложные куски — в отдельные переменные или подкомпоненты.
8. После решения — коротко: на что обратить внимание (лишние ре-рендеры, производительность, краевые случаи UI).

Общее для обоих типов: между «умным» и читаемым решением выбирай читаемое; не переусложняй.

ДОПОЛНИТЕЛЬНО:
- Если на скриншотах есть начальная сигнатура функции, шаблон компонента или код — используй именно его.
- Язык — JavaScript/TypeScript (React — в JSX/TSX); если на скриншоте явно другой стек, используй его.
- Решай ТОЛЬКО то, что реально видно на скриншотах; не выдумывай условие.

ФОРМАТ ОТВЕТА — верни СТРОГО валидный JSON-объект (без markdown-обёртки вокруг него):
{
  "short": "Тип (алгоритм / React / теория-система / поведенческий), суть и подход — 1-2 предложения",
  "detailed": "Разбор по правилам своего типа. Для задач по коду — ПОЛНЫЙ рабочий код в тройных обратных кавычках (\`\`\`), сложность O(...) и краевые случаи. Для React — заметки по ре-рендерам. Для теории/системы — суть, узкие места, trade-offs, при необходимости фрагмент кода/схема."
}

- Возвращай ТОЛЬКО JSON-объект.`;

// Голосовые подсказки — быстрая модель (важна задержка ответа).
// gpt-4o ощутимо медленнее (10-15 сек на голосе с json_object); факт-якоря
// в промпте закрывают известные пробелы mini-модели в фактах.
const VOICE_MODEL = "gpt-4o-mini";
// Решение задач по коду — reasoning-модель: думает пошагово, сильна в
// алгоритмах. Медленнее, но для режима «по кнопке» это приемлемо.
const TASK_MODEL = "o4-mini";

// --- Маршрутизатор стрим-событий ---
// Один на модуль: OpenAIClient может пересоздаваться (см. init в overlay.js),
// а слушатели IPC должны регистрироваться единожды при загрузке скрипта.
let _streamSink = null; // { onDelta, resolve, reject, raw }

window.ghostAPI.onChatStreamDelta((delta) => {
  if (!_streamSink) return;
  _streamSink.raw += delta;
  try {
    _streamSink.onDelta(_streamSink.raw);
  } catch (e) {
    /* ошибка в onProgress-колбэке не должна рвать стрим */
  }
});

window.ghostAPI.onChatStreamEnd((payload) => {
  if (!_streamSink) return;
  const sink = _streamSink;
  _streamSink = null;
  if (payload && payload.error) sink.reject(new Error(payload.error));
  else sink.resolve(payload && payload.text != null ? payload.text : sink.raw);
});

class OpenAIClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.recentHints = []; // последние выданные подсказки — чтобы не повторяться
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  // Сброс контекста — после очистки беседы (новый вопрос с чистого листа).
  clearContext() {
    this.recentHints = [];
  }

  // Голосовая подсказка по диалогу (текст, без скриншотов).
  // dialog — текст диалога с метками «Собеседник:» / «Я:».
  // onProgress({ short, isAddon }) — вызывается по мере стриминга:
  // только короткая часть и флаг addon. Развёрнутая часть приходит одним
  // куском в финале — иначе разметка код-блоков «прыгала» бы во время
  // чтения.
  async getHint({ dialog, reason }, onProgress) {
    const messages = [{ role: "system", content: GHOST_SYSTEM_PROMPT }];

    // Контекст: последние 2 подсказки, чтобы не повторяться.
    // 2 хватает для дельты, а первый токен приходит заметно быстрее, чем с 3.
    for (const prev of this.recentHints.slice(-2)) {
      messages.push({ role: "assistant", content: prev });
    }

    messages.push({
      role: "user",
      content:
        `[Триггер: ${reason}]\n\n` +
        `Диалог (последние 30 сек):\n${dialog || "(тишина)"}`,
    });

    let raw;
    try {
      raw = await this._chatStream(
        VOICE_MODEL,
        messages,
        700,
        0.6,
        { type: "json_object" },
        (partial) => {
          if (onProgress) onProgress(this._partialHint(partial));
        }
      );
    } catch (e) {
      console.error("OpenAI:", e.message);
      return null;
    }
    if (!raw) return null;

    const hint = this._parseHint(raw);
    if (hint && (hint.short || hint.detailed)) {
      // В контекст «не повторяйся» кладём ответ в исходном JSON-формате
      // (как assistant его и выдал) — обе части целиком, чтобы модель
      // на следующий триггер видела, что уже было сказано, и могла дать
      // дельту, а не пересказывать всё заново. Detailed подрезаем агрессивно:
      // для распознавания темы хватает 400 симв., а первый токен быстрее.
      const detailedCap = 400;
      const detailedTrimmed =
        hint.detailed && hint.detailed.length > detailedCap
          ? hint.detailed.slice(0, detailedCap) + "…"
          : hint.detailed || "";
      this.recentHints.push(
        JSON.stringify({
          short: hint.short || "",
          detailed: detailedTrimmed,
          isAddon: !!hint.isAddon,
        })
      );
      if (this.recentHints.length > 10) this.recentHints.shift();
    }
    return hint;
  }

  // Решение задачи по скриншотам (1-3 изображения).
  // images — массив base64-строк JPEG.
  async solveTask(images) {
    if (!images || !images.length) return null;

    const content = [
      {
        type: "text",
        text:
          `Скриншоты с задачей по программированию (${images.length} шт.). ` +
          `Условие и данные могут быть распределены по разным снимкам — ` +
          `собери всё вместе и реши задачу.`,
      },
    ];
    for (const img of images) {
      content.push({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${img}`,
          detail: "high", // нужно прочитать код и мелкий текст
        },
      });
    }

    const messages = [
      { role: "system", content: SOLVE_TASK_PROMPT },
      { role: "user", content },
    ];

    // Бюджет токенов с запасом — reasoning-модель тратит часть на «мысли».
    const raw = await this._chat(TASK_MODEL, messages, 8000, undefined, {
      type: "json_object",
    });
    if (!raw) return null;
    return this._parseHint(raw);
  }

  // Обсуждение уже решённой задачи. На вход — те же скриншоты, текущее
  // решение и расшифровка разговора. Отвечаем на последнюю реплику в
  // контексте задачи: уточняем решение либо отвечаем на вопрос о нём.
  async discussTask(images, prevSolution, dialog) {
    if (!images || !images.length) return null;

    const prev =
      "Краткое: " +
      ((prevSolution && prevSolution.short) || "—") +
      "\nРазвёрнутое: " +
      ((prevSolution && prevSolution.detailed) || "—");

    const content = [
      {
        type: "text",
        text:
          `Та же задача по программированию (скриншоты ниже).\n` +
          `Текущее решение:\n${prev}\n\n` +
          `Идёт обсуждение задачи. Расшифровка разговора ` +
          `(«Собеседник:» — интервьюер, «Я:» — пользователь):\n` +
          `${dialog || "(пока тишина)"}\n\n` +
          `Ответь на ПОСЛЕДНЮЮ реплику/вопрос в контексте этой задачи и её ` +
          `решения: если просят изменить или улучшить решение — дай ` +
          `обновлённое решение; если задают вопрос о решении (сложность, ` +
          `почему так, краевые случаи, альтернативы) — ответь по сути. ` +
          `Формат ответа — тот же JSON-объект.`,
      },
    ];
    for (const img of images) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${img}`, detail: "high" },
      });
    }

    const messages = [
      { role: "system", content: SOLVE_TASK_PROMPT },
      { role: "user", content },
    ];

    const raw = await this._chat(TASK_MODEL, messages, 8000, undefined, {
      type: "json_object",
    });
    if (!raw) return null;
    return this._parseHint(raw);
  }

  // Разбор JSON-ответа модели в { short, detailed, isAddon }.
  // При сбое парсинга весь текст уходит в detailed — ответ не теряется.
  _parseHint(raw) {
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      obj = null;
    }
    if (!obj || typeof obj !== "object") {
      return { short: "", detailed: String(raw).trim(), isAddon: false };
    }
    return {
      short: (obj.short || "").trim(),
      detailed: (obj.detailed || "").trim(),
      isAddon: !!obj.isAddon,
    };
  }

  async _chat(model, messages, maxTokens, temperature, responseFormat) {
    // reasoning-модели (o1/o3/o4…) используют свой параметр лимита токенов
    // и не принимают temperature — у них он всегда равен 1.
    const reasoning = /^o\d/.test(model);
    const body = { model, messages };
    if (reasoning) {
      body.max_completion_tokens = maxTokens;
    } else {
      body.max_tokens = maxTokens;
      body.temperature = temperature;
    }
    if (responseFormat) body.response_format = responseFormat;
    const res = await window.ghostAPI.chat(this.apiKey, body);
    if (res.error) {
      console.error("OpenAI:", res.error);
      return null;
    }
    const content =
      res.data &&
      res.data.choices &&
      res.data.choices[0] &&
      res.data.choices[0].message &&
      res.data.choices[0].message.content;
    return content ? content.trim() : null;
  }

  // Стриминг-вариант _chat: резолвится полным текстом ответа, а по дороге
  // зовёт onDelta(накопленный_текст) — для живого показа «short».
  _chatStream(model, messages, maxTokens, temperature, responseFormat, onDelta) {
    return new Promise((resolve, reject) => {
      _streamSink = { onDelta: onDelta || (() => {}), resolve, reject, raw: "" };
      const body = { model, messages, max_tokens: maxTokens, temperature };
      if (responseFormat) body.response_format = responseFormat;
      window.ghostAPI.chatStream(this.apiKey, body);
    });
  }

  // Достаёт значение строкового поля из (возможно НЕПОЛНОГО) JSON.
  _extractJsonString(text, key) {
    const at = text.indexOf('"' + key + '"');
    if (at < 0) return null;
    let i = text.indexOf(":", at + key.length + 2);
    if (i < 0) return null;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '"') return null;
    i++; // за открывающую кавычку
    let out = "";
    while (i < text.length) {
      const c = text[i];
      if (c === '"') return out; // строка закрылась — поле получено целиком
      if (c === "\\") {
        const n = text[i + 1];
        if (n === undefined) break; // обрыв на середине escape-последовательности
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "r") out += "\r";
        else if (n === "u") {
          const hex = text.slice(i + 2, i + 6);
          if (hex.length < 4) break;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        } else out += n;
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out; // строка ещё не закрылась — отдаём, что накопилось
  }

  // Достаёт булевое значение поля из (возможно НЕПОЛНОГО) JSON. Возвращает
  // null, если значение ещё не дошло. Используется для раннего определения
  // "isAddon": стоит первым в JSON, поэтому распознаётся в первых же дельтах.
  _extractJsonBool(text, key) {
    const at = text.indexOf('"' + key + '"');
    if (at < 0) return null;
    let i = text.indexOf(":", at + key.length + 2);
    if (i < 0) return null;
    i++;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text.startsWith("true", i)) return true;
    if (text.startsWith("false", i)) return false;
    return null;
  }

  // Частичный разбор ответа во время стриминга → { short, isAddon }.
  // Развёрнутую часть (detailed) намеренно НЕ стримим: её разметка
  // с код-блоками «прыгала» бы во время чтения.
  _partialHint(raw) {
    return {
      short: this._extractJsonString(raw, "short") || "",
      isAddon: this._extractJsonBool(raw, "isAddon"),
    };
  }
}
