import { describe, expect, it } from "vitest";
import {
  composeDraft,
  createDictation,
  describeRecognitionError,
  MAX_MESSAGE_LENGTH,
  recognitionLanguage,
  speechRecognitionConstructor,
  transcriptOf,
  type DictationProblem,
  type RecognitionLike,
  type RecognitionResultEventLike,
} from "@/lib/voice/dictation";

/**
 * Phase G: the rules behind the AI waiter's mic, with a fake recognizer
 * standing in for the browser. The component around it is
 * tests/unit/voice-input-button.test.tsx.
 */

function results(
  ...parts: Array<[string, boolean]>
): RecognitionResultEventLike {
  return {
    results: parts.map(([transcript, isFinal]) =>
      Object.assign([{ transcript }], { isFinal }),
    ),
  };
}

class FakeRecognition implements RecognitionLike {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 5;
  onresult: RecognitionLike["onresult"] = null;
  onerror: RecognitionLike["onerror"] = null;
  onend: RecognitionLike["onend"] = null;
  started = false;
  stopped = false;
  aborted = false;
  constructor() {
    FakeRecognition.instances.push(this);
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onerror?.({ error: "aborted" });
    this.onend?.();
  }
}

function setup(lang = "en-US") {
  FakeRecognition.instances = [];
  const drafts: string[] = [];
  const listening: boolean[] = [];
  const problems: DictationProblem[] = [];
  const dictation = createDictation({
    Recognition: FakeRecognition,
    lang,
    onDraft: (d) => drafts.push(d),
    onListening: (l) => listening.push(l),
    onProblem: (p) => problems.push(p),
  });
  const current = () => FakeRecognition.instances.at(-1)!;
  return { dictation, drafts, listening, problems, current };
}

describe("where the mic appears", () => {
  it("uses the standard API, then Safari's prefixed one", () => {
    function Standard() {}
    function Prefixed() {}
    expect(speechRecognitionConstructor({ SpeechRecognition: Standard })).toBe(
      Standard,
    );
    expect(
      speechRecognitionConstructor({ webkitSpeechRecognition: Prefixed }),
    ).toBe(Prefixed);
  });

  it("finds nothing in Firefox or on the server, so no button is shown", () => {
    expect(speechRecognitionConstructor({})).toBeNull();
    expect(speechRecognitionConstructor(undefined)).toBeNull();
    expect(
      speechRecognitionConstructor({ webkitSpeechRecognition: "yes" }),
    ).toBeNull();
  });
});

describe("the language it listens in", () => {
  it("is the diner's own first language", () => {
    expect(recognitionLanguage(["hi-IN", "en-US"])).toBe("hi-IN");
    expect(recognitionLanguage(["es-MX"])).toBe("es-MX");
  });

  it("falls back to English when the browser says nothing usable", () => {
    expect(recognitionLanguage([])).toBe("en-US");
    expect(recognitionLanguage(undefined)).toBe("en-US");
    expect(recognitionLanguage([""])).toBe("en-US");
  });
});

describe("what lands in the box", () => {
  it("joins everything heard so far, final and interim", () => {
    expect(
      transcriptOf(results(["is the dosa", true], [" spicy", false])),
    ).toBe("is the dosa spicy");
  });

  it("keeps what was typed and adds the speech after it", () => {
    expect(composeDraft("Two chai and", "is the dosa spicy")).toBe(
      "Two chai and is the dosa spicy",
    );
    expect(composeDraft("Hello ", "hi")).toBe("Hello hi");
    expect(composeDraft("", "  hi  ")).toBe("hi");
    expect(composeDraft("typed", "")).toBe("typed");
  });

  it("never overflows the message limit", () => {
    expect(
      composeDraft("a".repeat(MAX_MESSAGE_LENGTH - 2), "more words"),
    ).toHaveLength(MAX_MESSAGE_LENGTH);
  });
});

describe("a dictation session", () => {
  it("listens once, in the diner's language, with words appearing as spoken", () => {
    const { dictation, current, listening } = setup("hi-IN");
    dictation.start("");
    const r = current();
    expect(r.started).toBe(true);
    expect(r.lang).toBe("hi-IN");
    expect(r.continuous).toBe(false);
    expect(r.interimResults).toBe(true);
    expect(r.maxAlternatives).toBe(1);
    expect(listening).toEqual([true]);
  });

  it("fills the box as the diner speaks, and never sends", () => {
    const { dictation, current, drafts } = setup();
    dictation.start("Table 4:");
    current().onresult?.(results(["is the", false]));
    current().onresult?.(results(["is the dosa spicy", true]));
    expect(drafts).toEqual(["Table 4: is the", "Table 4: is the dosa spicy"]);
    // There is no send path in this module at all — the panel's send button
    // is the only way a message leaves.
  });

  it("stops on a tap and keeps what was heard", () => {
    const { dictation, current, listening, drafts } = setup();
    dictation.start("");
    current().onresult?.(results(["two chai", true]));
    dictation.stop();
    expect(current().stopped).toBe(true);
    expect(listening).toEqual([true, false]);
    expect(drafts.at(-1)).toBe("two chai");
  });

  it("aborting (sent, or the chat closed) is silent and ignores late results", () => {
    const { dictation, current, listening, drafts, problems } = setup();
    dictation.start("");
    const r = current();
    dictation.abort();
    r.onresult?.(results(["late words", true]));
    expect(r.aborted).toBe(true);
    expect(listening).toEqual([true, false]);
    expect(drafts).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("uses a fresh recognizer each time", () => {
    const { dictation } = setup();
    dictation.start("");
    dictation.stop();
    dictation.start("");
    expect(FakeRecognition.instances).toHaveLength(2);
  });

  it("ignores a second start while already listening", () => {
    const { dictation } = setup();
    dictation.start("");
    dictation.start("");
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("reports a browser that refuses to start", () => {
    class Refusing extends FakeRecognition {
      start() {
        throw new Error("InvalidStateError");
      }
    }
    const listening: boolean[] = [];
    const problems: DictationProblem[] = [];
    createDictation({
      Recognition: Refusing,
      lang: "en-US",
      onDraft: () => {},
      onListening: (l) => listening.push(l),
      onProblem: (p) => problems.push(p),
    }).start("");
    expect(listening).toEqual([true, false]);
    expect(problems[0].giveUp).toBe(false);
  });

  it("passes on a problem in plain words", () => {
    const { dictation, current, problems } = setup();
    dictation.start("");
    current().onerror?.({ error: "not-allowed" });
    expect(problems).toEqual([
      {
        message:
          "The microphone is blocked for this site. You can still type your message.",
        giveUp: true,
      },
    ]);
  });
});

describe("problems", () => {
  it("takes the mic away only when it cannot work this visit", () => {
    for (const code of [
      "not-allowed",
      "service-not-allowed",
      "audio-capture",
      "language-not-supported",
    ]) {
      expect(describeRecognitionError(code)?.giveUp).toBe(true);
    }
    for (const code of ["no-speech", "network", "something-new"]) {
      expect(describeRecognitionError(code)?.giveUp).toBe(false);
    }
  });

  it("stays quiet when we stopped it ourselves", () => {
    expect(describeRecognitionError("aborted")).toBeNull();
  });

  it("always leaves the diner a way forward", () => {
    for (const code of [
      "no-speech",
      "not-allowed",
      "service-not-allowed",
      "audio-capture",
      "language-not-supported",
      "network",
      "unknown",
    ]) {
      expect(describeRecognitionError(code)?.message).toMatch(
        /try again|type your message/i,
      );
    }
  });
});
