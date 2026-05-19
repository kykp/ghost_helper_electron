// Клиент OpenAI. Сами HTTP-запросы уходят из main process (см. preload →
// ghostAPI.chat), здесь — сборка сообщений и история подсказок для контекста.

const GHOST_SYSTEM_PROMPT = `Ты — невидимый AI-ассистент на техническом собеседовании. Пользователь проходит интервью на позицию Senior Frontend Developer (React / JavaScript / TypeScript).

ТВОЯ РОЛЬ:
Тебе дают расшифровку диалога. Строки «Собеседник:» — реплики интервьюера. Строки «Я:» — реплики пользователя. Твоя задача — мгновенно дать пользователю короткую, точную подсказку, которая поможет ответить уверенно и на уровне Senior.

Помогай ответить на ПОСЛЕДНИЙ вопрос в диалоге. Обычно его задаёт «Собеседник:», но иногда вопрос звучит в строке «Я:» — это значит, что интервьюер прислал вопрос текстом, а пользователь читает его вслух. В этом случае всё равно дай подсказку по этому вопросу. Если последняя реплика «Я:» — это не вопрос, а попытка ответить по сути, реагировать на неё не нужно.

ФОРМАТ ОТВЕТА — верни СТРОГО валидный JSON-объект (без markdown-обёртки вокруг него) с тремя полями:
{
  "short": "Краткий ответ — 1-2 предложения. Чёткое определение или прямой ответ по сути. Это то, что пользователь прочитает и скажет первым.",
  "detailed": "Развёрнутый ответ — подробное объяснение с контекстом. ОБЯЗАТЕЛЬНО добавляй примеры кода: оборачивай каждый фрагмент в тройные обратные кавычки (\`\`\`). Если тема предполагает перечисление (типы данных, виды хуков, методы массива и т.п.) — каждый пункт с новой строки и короткий пример кода к каждому пункту.",
  "followups": ["вероятный уточняющий вопрос интервьюера по этой теме", "ещё один"]
}

Требования к содержимому:
- Говори простым, живым языком — так, как объясняет коллега, а не учебник. Без академических, сухих и канцелярских оборотов
- "short" — коротко и уверенно, без воды; этим пользователь начинает ответ вслух
- "detailed" — глубже и точнее, с рабочими примерами кода; используй термины правильно
- "followups" — 2-3 вопроса, которые интервьюер с большой вероятностью задаст следом по этой теме (для подготовки). Если придумать нечего — пустой массив []
- Если на экране код — в "detailed" укажи конкретно, что исправить или написать

ОБЛАСТИ ЗНАНИЙ (приоритет):

1. React:
   - Хуки (useState, useEffect, useCallback, useMemo, useRef, useContext, useReducer, кастомные хуки)
   - Жизненный цикл компонентов, reconciliation, Virtual DOM, Fiber
   - Паттерны: HOC, render props, compound components, controlled/uncontrolled
   - React Server Components, Suspense, Error Boundaries, Portals
   - Оптимизация: React.memo, code splitting, lazy loading
   - Состояние: Redux, Redux Toolkit, Zustand, Jotai, Recoil, Context API — когда что выбрать

2. JavaScript / TypeScript:
   - Замыкания, прототипное наследование, this, call/apply/bind
   - Event Loop, микро/макрозадачи, Promise, async/await, генераторы
   - ES6+: деструктуризация, spread, Map/Set/WeakMap, Proxy, Symbol
   - TypeScript: generics, utility types, type guards, discriminated unions, mapped types, conditional types, infer
   - Паттерны проектирования: Observer, Factory, Strategy, Singleton, Module

3. Браузер и Web:
   - DOM, события, делегирование, Shadow DOM, Web Components
   - Rendering pipeline: Layout, Paint, Composite, reflow vs repaint
   - Web API: IntersectionObserver, MutationObserver, ResizeObserver, Web Workers, Service Workers
   - Хранение: localStorage, sessionStorage, IndexedDB, cookies — отличия и лимиты
   - Безопасность: XSS, CSRF, CSP, CORS, SameSite cookies

4. Архитектура и инфраструктура:
   - Webpack, Vite, esbuild, Turbopack — отличия, tree shaking, code splitting
   - SSR vs CSR vs SSG vs ISR (Next.js)
   - Микрофронтенды: Module Federation, single-spa
   - Монорепо: Nx, Turborepo
   - CI/CD, Docker, линтинг, тестирование

5. Тестирование:
   - Jest, React Testing Library, Vitest
   - Unit, integration, e2e (Cypress, Playwright)
   - Что тестировать, а что нет, пирамида тестирования
   - Мокирование, стабы, TDD

6. Производительность:
   - Core Web Vitals: LCP, FID/INP, CLS
   - Lighthouse, профилирование в DevTools
   - Ленивая загрузка, виртуализация списков, debounce/throttle
   - Кэширование: HTTP cache, CDN, stale-while-revalidate

7. Лидерство (Senior-уровень):
   - Код-ревью, менторинг, RFC-процесс
   - Принятие технических решений, trade-offs
   - Декомпозиция задач, эстимейты
   - Работа с техдолгом, миграции

КАК СТРОИТЬ ОТВЕТ ПО ТИПУ ВОПРОСА:
- Теоретический вопрос: "short" — определение; "detailed" — как работает + пример кода
- Вопрос по коду на экране: "short" — в чём проблема/что сделать; "detailed" — решение с кодом и почему
- Live coding: "short" — какой подход; "detailed" — шаги и код, не забудь edge cases
- Архитектурный вопрос: "short" — решение; "detailed" — плюсы, trade-offs, пример
- Поведенческий (soft skills): "short" — суть; "detailed" — структура STAR (Situation → Task → Action → Result)

ЗАПРЕЩЕНО:
- Академический, сухой, канцелярский язык — пиши так, как люди говорят вживую
- Банальности типа "React — это библиотека для UI"
- Неуверенные формулировки — ты подсказываешь Senior-у
- Повторять вопрос интервьюера в подсказке
- Реагировать на реплики «Я:», где пользователь просто отвечает по сути (а не задаёт/читает вопрос) — на них подсказка не нужна
- Возвращать что-либо кроме JSON-объекта
- Выдумывать проблему по коду, если код на скриншоте не виден или не читается.
  В этом случае разбирай только текст вопроса; если и его нет — верни
  {"short":"—","detailed":"","followups":[]} и ничего не придумывай.`;

// Промпт для режима «решение задачи по скриншотам».
const SOLVE_TASK_PROMPT = `Ты senior JavaScript/TypeScript/React разработчик. Тебе дают 1-5 скриншотов с условием задачи — это может быть алгоритмическая задача ИЛИ задача по React (компонент, хук, исправление бага в JSX). Условие, примеры и данные могут быть распределены по разным скриншотам — собери всё в одну задачу, определи её тип и реши.

ПРАВИЛА ДЛЯ АЛГОРИТМИЧЕСКИХ ЗАДАЧ:
1. Решай гибко и просто: не следуй формулировке условия буквально — шаги можно объединять, переупорядочивать и упрощать, если так решение чище, лишь бы результат оставался верным. Ищи самый простой путь к ответу.
2. Предпочитай декларативный стиль: цепочки filter/map/reduce/sort. Императивные циклы — только когда они реально проще или эффективнее.
3. Не мутируй входные данные. Если нужна сортировка — работай с копией.
4. Убирай лишнее: если промежуточная переменная используется один раз — встрой её в цепочку. Если Set/Map решает задачу в одну строку вместо ручного цикла — используй их.
5. Не переусложняй. Между «умным» однострочником и читаемым решением в 3–5 строк выбирай читаемое.
6. После решения — коротко (2–3 предложения): временная и пространственная сложность, и есть ли альтернативный подход, который стоит знать.
7. Если в задаче есть краевые случаи (пустой массив, все элементы одинаковые, отрицательные значения) — упомяни их, но не раздувай код проверками, если это не просят.

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
  "short": "Тип задачи (алгоритм / React), суть и выбранный подход — 1-2 предложения",
  "detailed": "Разбор решения и ПОЛНЫЙ рабочий код в тройных обратных кавычках (\`\`\`), написанный по правилам своего типа задачи. В конце — закрывающий абзац: для алгоритма сложность по времени и памяти O(...) и альтернативный подход; для React — заметки по ре-рендерам и производительности; в обоих случаях — краевые случаи.",
  "followups": ["возможная вариация задачи, которую стоит уметь решать", "ещё одна"]
}

- Если на скриншотах нет задачи по коду — верни {"short":"На скриншотах не видно задачи по коду","detailed":"","followups":[]}.
- Возвращай ТОЛЬКО JSON-объект.`;

// Голосовые подсказки — быстрая модель (важна задержка).
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
  // onProgress({ short, detailed }) — вызывается по мере стриминга ответа.
  async getHint({ dialog, reason }, onProgress) {
    const messages = [{ role: "system", content: GHOST_SYSTEM_PROMPT }];

    // Контекст: последние 3 подсказки, чтобы не повторяться.
    for (const prev of this.recentHints.slice(-3)) {
      messages.push({ role: "assistant", content: prev });
    }

    messages.push({
      role: "user",
      content:
        `[Триггер: ${reason}]\n\n` +
        `Диалог (последние 60 сек):\n${dialog || "(тишина)"}`,
    });

    let raw;
    try {
      raw = await this._chatStream(
        VOICE_MODEL,
        messages,
        1000,
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
    if (hint) {
      // В контекст «не повторяйся» кладём краткую часть.
      this.recentHints.push(hint.short || hint.detailed || "");
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

  // Разбор JSON-ответа модели в { short, detailed, followups }.
  // При сбое парсинга весь текст уходит в detailed — ответ не теряется.
  _parseHint(raw) {
    let obj = null;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      obj = null;
    }
    if (!obj || typeof obj !== "object") {
      return { short: "", detailed: String(raw).trim(), followups: [] };
    }
    const followups = Array.isArray(obj.followups)
      ? obj.followups
          .filter((q) => typeof q === "string" && q.trim())
          .map((q) => q.trim())
      : [];
    return {
      short: (obj.short || "").trim(),
      detailed: (obj.detailed || "").trim(),
      followups,
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
  // зовёт onDelta(накопленный_текст) — для живого показа подсказки.
  _chatStream(model, messages, maxTokens, temperature, responseFormat, onDelta) {
    return new Promise((resolve, reject) => {
      _streamSink = { onDelta: onDelta || (() => {}), resolve, reject, raw: "" };
      const body = { model, messages, max_tokens: maxTokens, temperature };
      if (responseFormat) body.response_format = responseFormat;
      window.ghostAPI.chatStream(this.apiKey, body);
    });
  }

  // Достаёт значение строкового поля из (возможно НЕПОЛНОГО) JSON —
  // нужно, чтобы показывать ответ ещё до того, как он сгенерён целиком.
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
        } else out += n; // \"  \\  \/  и пр.
        i += 2;
        continue;
      }
      out += c;
      i++;
    }
    return out; // строка ещё не закрылась — отдаём, что накопилось
  }

  // Частичный разбор ответа во время стриминга → { short, detailed }.
  _partialHint(raw) {
    return {
      short: this._extractJsonString(raw, "short") || "",
      detailed: this._extractJsonString(raw, "detailed") || "",
    };
  }
}
