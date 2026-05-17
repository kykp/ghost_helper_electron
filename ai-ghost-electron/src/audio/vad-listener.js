// Прослушивание одного источника звука на основе VAD (Voice Activity Detection).
//
// Вместо нарезки по таймеру речь делится на utterance'ы: VAD ловит начало
// речи и её окончание (пауза ~1.5 сек), и только ЦЕЛАЯ реплика уходит в
// Whisper. Так распознаётся вопрос целиком, а не обрезок.
//
// Один экземпляр = один источник: 'me' (микрофон) или 'them' (системный звук).
// Глобали vad / ort приходят из vendor-скриптов (см. overlay.html).

// Папка с моделью VAD, wasm-рантаймом и audio-worklet.
const VAD_ASSET_PATH = "ghost://app/src/vendor/vad/";

// Контекстная подсказка для Whisper — резко улучшает распознавание терминов.
const WHISPER_PROMPT =
  "Техническое собеседование. React, JavaScript, TypeScript, useState, " +
  "useEffect, useCallback, useMemo, useRef, useContext, useReducer, Redux, " +
  "Redux Toolkit, Zustand, Webpack, Vite, esbuild, Next.js, SSR, CSR, SSG, " +
  "ISR, API, REST, GraphQL, Virtual DOM, Fiber, reconciliation, Suspense, " +
  "компонент, хук, рендер, стейт, пропсы, контекст, замыкание, промис.";

class VadListener {
  // source: 'me' | 'them'
  constructor(source) {
    this.source = source;
    this.apiKey = "";
    this.lang = "ru";

    this.vad = null;
    this.running = false;

    this.onUtterance = null; // ({ source, text, durationMs, isRepeat })
    this.onSpeechStart = null; // (source)
    this.onSpeechEnd = null; // (source)
    this.onError = null; // (Error)

    // Кольцевой буфер сырого аудио — для ручного повтора распознавания.
    this.recentAudio = []; // [{ audio: Float32Array, ts }]
    this.recentAudioMaxAge = 30000;
  }

  configure({ apiKey, lang } = {}) {
    if (apiKey != null) this.apiKey = apiKey;
    if (lang != null) this.lang = lang;
  }

  // streamProvider: async () => MediaStream — откуда брать звук.
  async start(streamProvider) {
    if (this.running) return;
    this.vad = await vad.MicVAD.new({
      model: "v5",
      baseAssetPath: VAD_ASSET_PATH,
      onnxWASMBasePath: VAD_ASSET_PATH,
      // Реплика завершается после ~1.5 сек тишины — это целая мысль.
      redemptionMs: 1500,
      minSpeechMs: 250,
      preSpeechPadMs: 400,
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      ortConfig: (ort) => {
        ort.env.logLevel = "error";
        if (ort.env.wasm) ort.env.wasm.numThreads = 1;
      },
      getStream: streamProvider,
      onSpeechStart: () => {
        if (this.onSpeechStart) this.onSpeechStart(this.source);
      },
      onVADMisfire: () => {},
      onSpeechEnd: (audio) => this._onSpeechEnd(audio),
    });
    this.vad.start();
    this.running = true;
  }

  _onSpeechEnd(audio) {
    if (this.onSpeechEnd) this.onSpeechEnd(this.source);
    this.recentAudio.push({ audio, ts: Date.now() });
    this._trimRecent();
    this._transcribe(audio, false);
  }

  // Float32 (16 кГц) → WAV → Whisper. isRepeat помечает ручной повтор.
  async _transcribe(audio, isRepeat) {
    try {
      const wav = vad.utils.encodeWAV(audio, 1, 16000, 1, 16);
      const res = await window.ghostAPI.transcribe(
        this.apiKey,
        wav,
        "audio/wav",
        this.lang,
        WHISPER_PROMPT
      );
      if (res.error) {
        console.warn("STT:", res.error);
        return null;
      }
      const text = (res.text || "").trim();
      if (!text) return null;
      const durationMs = Math.round((audio.length / 16000) * 1000);
      if (this.onUtterance) {
        this.onUtterance({ source: this.source, text, durationMs, isRepeat });
      }
      return text;
    } catch (e) {
      console.warn("STT fail:", e);
      if (this.onError) this.onError(e);
      return null;
    }
  }

  // Ручной повтор: пересобрать последние `seconds` сек сырого аудио и
  // распознать заново (с тем же контекстным prompt'ом).
  async repeatLast(seconds = 10) {
    const cutoff = Date.now() - seconds * 1000;
    const parts = this.recentAudio
      .filter((r) => r.ts > cutoff)
      .map((r) => r.audio);
    if (!parts.length) return null;
    const total = parts.reduce((n, a) => n + a.length, 0);
    const merged = new Float32Array(total);
    let off = 0;
    for (const a of parts) {
      merged.set(a, off);
      off += a.length;
    }
    return this._transcribe(merged, true);
  }

  _trimRecent() {
    const cutoff = Date.now() - this.recentAudioMaxAge;
    this.recentAudio = this.recentAudio.filter((r) => r.ts > cutoff);
  }

  pause() {
    if (this.vad && this.running) {
      try {
        this.vad.pause();
      } catch (e) {
        /* noop */
      }
    }
  }

  resume() {
    if (this.vad && this.running) {
      try {
        this.vad.start();
      } catch (e) {
        /* noop */
      }
    }
  }

  async destroy() {
    if (this.vad) {
      try {
        this.vad.destroy();
      } catch (e) {
        /* noop */
      }
      this.vad = null;
    }
    this.running = false;
    this.recentAudio = [];
  }
}
