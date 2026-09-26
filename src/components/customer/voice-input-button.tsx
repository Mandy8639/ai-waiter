"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Mic, Square } from "lucide-react";
import {
  createDictation,
  recognitionLanguage,
  speechRecognitionConstructor,
  type Dictation,
} from "@/lib/voice/dictation";
import { cn } from "@/lib/utils";

/**
 * The mic next to the AI waiter's message box (phase G). Speech fills the
 * box; it never sends — see src/lib/voice/dictation.ts for the rules.
 *
 * Renders nothing where the browser has no speech recognition (Firefox,
 * and on the server), and removes itself for the rest of the visit when a
 * browser that has the API refuses to use it.
 */

const noSubscription = () => () => {};
const browserSupportsSpeech = () =>
  speechRecognitionConstructor(window) !== null;
const serverSupportsSpeech = () => false;

export function VoiceInputButton({
  value,
  onDraft,
  disabled,
  onListeningChange,
  onNotice,
}: {
  /** What's in the box now; speech is added after it. */
  value: string;
  onDraft: (draft: string) => void;
  /** While a message is sending. Listening stops the moment this turns on. */
  disabled?: boolean;
  onListeningChange?: (listening: boolean) => void;
  /** A sentence for the diner when voice stops working; null clears it. */
  onNotice: (message: string | null) => void;
}) {
  const supported = useSyncExternalStore(
    noSubscription,
    browserSupportsSpeech,
    serverSupportsSpeech,
  );
  const [listening, setListening] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const dictation = useRef<Dictation | null>(null);

  // The dictation outlives renders; it reaches the latest callbacks here.
  const callbacks = useRef({ onDraft, onListeningChange, onNotice });
  useEffect(() => {
    callbacks.current = { onDraft, onListeningChange, onNotice };
  });

  useEffect(() => {
    if (disabled) dictation.current?.abort();
  }, [disabled]);

  // Closing the chat mid-sentence stops the microphone.
  useEffect(() => () => dictation.current?.abort(), []);

  if (!supported || gaveUp) return null;

  function getDictation(): Dictation | null {
    if (dictation.current) return dictation.current;
    const Recognition = speechRecognitionConstructor(window);
    if (!Recognition) return null;
    dictation.current = createDictation({
      Recognition,
      lang: recognitionLanguage(
        navigator.languages?.length
          ? navigator.languages
          : [navigator.language],
      ),
      onDraft: (draft) => callbacks.current.onDraft(draft),
      onListening: (isListening) => {
        setListening(isListening);
        callbacks.current.onListeningChange?.(isListening);
      },
      onProblem: (problem) => {
        callbacks.current.onNotice(problem.message);
        if (problem.giveUp) setGaveUp(true);
      },
    });
    return dictation.current;
  }

  function toggle() {
    if (listening) {
      dictation.current?.stop();
      return;
    }
    onNotice(null);
    getDictation()?.start(value);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={listening ? "Stop listening" : "Speak your message"}
      className={cn(
        "focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded-full transition-[background-color,color,opacity] focus-visible:ring-3 focus-visible:outline-none disabled:opacity-40",
        listening
          ? "bg-destructive/10 text-destructive animate-pulse"
          : "bg-muted/60 text-foreground hover:bg-muted",
      )}
    >
      {listening ? (
        <Square className="size-4 fill-current" aria-hidden="true" />
      ) : (
        <Mic className="size-5" aria-hidden="true" />
      )}
    </button>
  );
}
