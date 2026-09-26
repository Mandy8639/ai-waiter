// @vitest-environment jsdom
//
// The AI waiter's mic as a diner meets it (phase G). The rules are in
// tests/unit/voice-dictation.test.ts; this file checks the button is
// absent where it can't work and that speech fills the box without sending.
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { VoiceInputButton } from "@/components/customer/voice-input-button";
import type {
  RecognitionLike,
  RecognitionResultEventLike,
} from "@/lib/voice/dictation";

class FakeRecognition implements RecognitionLike {
  static last: FakeRecognition | null = null;
  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 5;
  onresult: RecognitionLike["onresult"] = null;
  onerror: RecognitionLike["onerror"] = null;
  onend: RecognitionLike["onend"] = null;
  aborted = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {}
  stop() {
    this.onend?.();
  }
  abort() {
    this.aborted = true;
    this.onend?.();
  }
}

function heard(text: string): RecognitionResultEventLike {
  return {
    results: [Object.assign([{ transcript: text }], { isFinal: true })],
  };
}

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <input aria-label="message" value={value} readOnly />
      <VoiceInputButton
        value={value}
        onDraft={setValue}
        disabled={disabled}
        onNotice={setNotice}
      />
      {notice && <p role="status">{notice}</p>}
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeRecognition.last = null;
});

describe("VoiceInputButton", () => {
  it("is absent where the browser has no speech recognition", () => {
    render(<Harness />);
    expect(
      screen.queryByRole("button", { name: "Speak your message" }),
    ).not.toBeInTheDocument();
  });

  it("puts what the diner said in the box, and only there", () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Speak your message" }));
    const stop = screen.getByRole("button", { name: "Stop listening" });
    expect(stop).toHaveAttribute("aria-pressed", "true");

    act(() => FakeRecognition.last!.onresult?.(heard("is the dosa spicy")));
    expect(screen.getByLabelText("message")).toHaveValue("is the dosa spicy");

    fireEvent.click(stop);
    expect(
      screen.getByRole("button", { name: "Speak your message" }),
    ).toHaveAttribute("aria-pressed", "false");
    // Still in the box, waiting for the diner to send it.
    expect(screen.getByLabelText("message")).toHaveValue("is the dosa spicy");
  });

  it("stops listening the moment a message starts sending", () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Speak your message" }));
    const recognition = FakeRecognition.last!;
    rerender(<Harness disabled />);
    expect(recognition.aborted).toBe(true);
  });

  it("goes away, with one plain sentence, when the microphone is blocked", () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Speak your message" }));
    act(() => {
      FakeRecognition.last!.onerror?.({ error: "not-allowed" });
      FakeRecognition.last!.onend?.();
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "The microphone is blocked for this site. You can still type your message.",
    );
    expect(
      screen.queryByRole("button", { name: /Speak|Stop/ }),
    ).not.toBeInTheDocument();
  });

  it("stops the microphone when the chat closes", () => {
    vi.stubGlobal("webkitSpeechRecognition", FakeRecognition);
    const { unmount } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Speak your message" }));
    const recognition = FakeRecognition.last!;
    unmount();
    expect(recognition.aborted).toBe(true);
  });
});
