/**
 * Voice input for the AI waiter (phase G): the browser's own speech
 * recognition, turned into text in the message box. No model, no server,
 * no cost — and no audio ever reaches Tableside.
 *
 * WHERE THE AUDIO GOES. Not here. The Web Speech API hands the audio to the
 * browser's speech service — Google's servers in Chrome, Apple's in Safari
 * — and gives back text. Tableside receives only the text, and only when
 * the diner presses send. The panel says so while the mic is listening.
 *
 * The rules this file enforces:
 *   1. NEVER SENDS. Speech fills the box; the diner reads it and sends it
 *      (or fixes it) themselves. A mis-heard "no nuts" must not go to the
 *      waiter unseen.
 *   2. ADDS TO WHAT'S TYPED. Anything already in the box is kept, and the
 *      speech goes after it.
 *   3. ABSENT WHERE IT CAN'T WORK. No API, no button (see
 *      speechRecognitionConstructor). A browser that has the API but refuses
 *      to use it — blocked microphone, an in-app browser without the
 *      service — gets one plain sentence and the button goes away.
 *
 * No DOM globals are touched here; the recognition constructor is handed
 * in, so every rule is unit-tested with a fake.
 */

/** The slice of SpeechRecognition this app uses. TypeScript's DOM lib does not ship it. */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionResultEventLike {
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

export type RecognitionConstructor = new () => RecognitionLike;

/** Chrome, Edge and Safari (prefixed); absent in Firefox. Null means: show no mic. */
export function speechRecognitionConstructor(
  scope: object | undefined,
): RecognitionConstructor | null {
  if (!scope) return null;
  const candidate = scope as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  const found =
    candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition;
  return typeof found === "function" ? (found as RecognitionConstructor) : null;
}

/**
 * Listen in the diner's own language: the first one their browser asks
 * for. A phone set to Hindi or Spanish is heard in Hindi or Spanish, which
 * the waiter answers in (phase E).
 */
export function recognitionLanguage(
  languages: readonly string[] | undefined,
): string {
  const first = languages?.find((tag) =>
    /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(tag),
  );
  return first ?? "en-US";
}

/** Everything heard so far in this session, final and still-changing alike. */
export function transcriptOf(event: RecognitionResultEventLike): string {
  const parts: string[] = [];
  for (let i = 0; i < event.results.length; i += 1) {
    const text = event.results[i]?.[0]?.transcript;
    if (text) parts.push(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export const MAX_MESSAGE_LENGTH = 2000;

/** What the box shows: what was typed before the mic, then what was said. */
export function composeDraft(typed: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return typed.slice(0, MAX_MESSAGE_LENGTH);
  const before = typed.replace(/\s+$/, "");
  return (before ? `${before} ${said}` : said).slice(0, MAX_MESSAGE_LENGTH);
}

export interface DictationProblem {
  message: string;
  /** Voice cannot work in this browser this visit; take the button away. */
  giveUp: boolean;
}

/** What to tell the diner, in plain words, for each way recognition stops. Null: say nothing. */
export function describeRecognitionError(
  code: string,
): DictationProblem | null {
  switch (code) {
    case "aborted":
      // We stopped it ourselves (sent, closed the chat, tapped the mic).
      return null;
    case "no-speech":
      return {
        message: "Didn't catch that. Tap the mic and try again.",
        giveUp: false,
      };
    case "not-allowed":
      return {
        message:
          "The microphone is blocked for this site. You can still type your message.",
        giveUp: true,
      };
    case "service-not-allowed":
      return {
        message:
          "Voice isn't available in this browser. You can still type your message.",
        giveUp: true,
      };
    case "audio-capture":
      return {
        message: "No microphone was found. You can still type your message.",
        giveUp: true,
      };
    case "language-not-supported":
      return {
        message:
          "Voice doesn't support your phone's language here. You can still type your message.",
        giveUp: true,
      };
    case "network":
      return {
        message:
          "Voice needs a connection to your browser's speech service. Try again, or type your message.",
        giveUp: false,
      };
    default:
      return {
        message:
          "Voice didn't work that time. You can still type your message.",
        giveUp: false,
      };
  }
}

export interface Dictation {
  start(typed: string): void;
  /** Stop listening and keep what was heard. */
  stop(): void;
  /** Stop listening, e.g. the message was sent or the chat closed. */
  abort(): void;
}

export function createDictation(options: {
  Recognition: RecognitionConstructor;
  lang: string;
  onDraft: (draft: string) => void;
  onListening: (listening: boolean) => void;
  onProblem: (problem: DictationProblem) => void;
}): Dictation {
  let current: RecognitionLike | null = null;

  function finish(instance: RecognitionLike) {
    if (current !== instance) return;
    current = null;
    options.onListening(false);
  }

  return {
    start(typed) {
      if (current) return;
      // A fresh instance per session: Safari does not reliably restart one
      // that has already ended.
      const recognition = new options.Recognition();
      recognition.lang = options.lang;
      recognition.continuous = false; // one question, then stop on a pause
      recognition.interimResults = true; // words appear as they're said
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        if (current !== recognition) return;
        options.onDraft(composeDraft(typed, transcriptOf(event)));
      };
      recognition.onerror = (event) => {
        if (current !== recognition) return;
        const problem = describeRecognitionError(event.error);
        if (problem) options.onProblem(problem);
      };
      recognition.onend = () => finish(recognition);

      current = recognition;
      options.onListening(true);
      try {
        recognition.start();
      } catch {
        finish(recognition);
        options.onProblem({
          message:
            "Voice didn't work that time. You can still type your message.",
          giveUp: false,
        });
      }
    },
    stop() {
      current?.stop();
    },
    abort() {
      const recognition = current;
      if (!recognition) return;
      finish(recognition);
      recognition.abort();
    },
  };
}
