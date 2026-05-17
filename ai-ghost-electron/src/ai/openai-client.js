// Клиент OpenAI. Сами HTTP-запросы уходят из main process (см. preload →
// ghostAPI.chat), здесь — сборка сообщений и история подсказок для контекста.

const GHOST_SYSTEM_PROMPT = `Ты — невидимый AI-ассистент на техническом собеседовании. Пользователь проходит интервью на позицию Senior Frontend Developer (React / JavaScript / TypeScript).

ТВОЯ РОЛЬ:
Тебе дают расшифровку диалога. Строки «Собеседник:» — реплики интервьюера. Строки «Я:» — реплики пользователя. Иногда виден скриншот экрана. Твоя задача — мгновенно дать пользователю короткую, точную подсказку, которая поможет ответить уверенно и на уровне Senior.

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

class OpenAIClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.recentHints = []; // последние выданные подсказки — чтобы не повторяться
  }

  setApiKey(key) {
    this.apiKey = key;
  }

  // Основной запрос подсказки.
  // dialog — текст диалога с метками «Собеседник:» / «Я:».
  // mode — 'live coding' | 'разговор'.
  async getHint({ dialog, screenshot, reason, mode }) {
    const messages = [{ role: "system", content: GHOST_SYSTEM_PROMPT }];

    // Контекст: последние 3 подсказки, чтобы не повторяться.
    for (const prev of this.recentHints.slice(-3)) {
      messages.push({ role: "assistant", content: prev });
    }

    const userContent = [
      {
        type: "text",
        text:
          `[Триггер: ${reason}]\n` +
          `[Режим: ${mode || "разговор"}]\n\n` +
          `Диалог (последние 60 сек):\n${dialog || "(тишина)"}`,
      },
    ];
    if (screenshot) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${screenshot}`,
          detail: "high", // нужно, чтобы GPT прочитал код на экране
        },
      });
    }
    messages.push({ role: "user", content: userContent });

    const raw = await this._chat(messages, 1000, 0.6, {
      type: "json_object",
    });
    if (!raw) return null;

    const hint = this._parseHint(raw);
    if (hint) {
      // В контекст «не повторяйся» кладём краткую часть.
      this.recentHints.push(hint.short || hint.detailed || "");
      if (this.recentHints.length > 10) this.recentHints.shift();
    }
    return hint;
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

  // Дешёвая классификация по первому скриншоту: на экране IDE/редактор кода?
  // По ней включается режим live coding (скриншоты прикладываются автоматически).
  async detectLiveCoding(screenshot) {
    if (!screenshot) return false;
    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "На скриншоте открыт редактор кода или IDE (VS Code, " +
              "WebStorm, CodeSandbox, LeetCode-редактор и т.п.)? " +
              "Ответь строго одним словом: да или нет.",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${screenshot}`,
              detail: "low",
            },
          },
        ],
      },
    ];
    const answer = await this._chat(messages, 5, 0);
    return !!answer && /да|yes/i.test(answer);
  }

  async _chat(messages, maxTokens, temperature, responseFormat) {
    const body = {
      model: "gpt-4o-mini",
      messages,
      max_tokens: maxTokens,
      temperature,
    };
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
}
