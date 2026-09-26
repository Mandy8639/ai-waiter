"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, ConciergeBell } from "lucide-react";
import {
  Dialog,
  DialogDescription,
  DialogSheetContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChatMarkdown } from "@/components/customer/chat-markdown";
import { RecommendationCard } from "@/components/customer/recommendation-card";
import {
  getChatHistory,
  sendChatMessage,
  type ChatHistoryEntry,
  type RecommendationCard as RecommendationCardData,
} from "@/lib/ai/actions";
import { cn } from "@/lib/utils";
import { ServiceRequestButtons } from "./service-request-buttons";
import { VoiceInputButton } from "./voice-input-button";

/**
 * Starter questions. Each is something the waiter genuinely answers from
 * this restaurant's data: recommendations (it asks the diner's mood, then
 * searches), dietary flags, confirmed allergens. None promises a feature
 * that doesn't exist.
 */
const STARTER_PROMPTS = [
  "What do you recommend?",
  "Something light, not too spicy",
  "Which dishes are vegan?",
  "Does anything contain peanuts?",
];

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  recommendations?: RecommendationCardData[];
}

export interface PromptRequest {
  /** Changes on every request, so asking the same question twice still sends. */
  id: number;
  text: string;
}

/**
 * What the waiting bubble says. The server does not report which tool is
 * running, so these describe only what is actually known — a request is in
 * flight, and for how long. Nothing claims "checking the menu" when that
 * may not be what is happening.
 */
function waitingLabel(seconds: number): string {
  if (seconds < 6) return "Your waiter is thinking…";
  if (seconds < 16) return "Still working on it…";
  return "Taking a little longer than usual — thanks for waiting.";
}

function WaiterAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-ai-soft text-ai flex shrink-0 items-center justify-center rounded-full",
        className,
      )}
    >
      <ConciergeBell className="size-[55%]" />
    </span>
  );
}

/**
 * The AI waiter conversation, as a sheet over the menu.
 *
 * Replies are rendered from a parsed, React-escaped tree (ChatMarkdown) —
 * never as HTML. Dish cards under a reply come from structured server data
 * (see src/lib/ai/recommendation-cards.ts), not from the text.
 */
export function AiWaiterPanel({
  restaurantSlug,
  restaurantName,
  open,
  onOpenChange,
  promptRequest,
  onPromptHandled,
  finalFocus,
}: {
  restaurantSlug: string;
  restaurantName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  promptRequest: PromptRequest | null;
  onPromptHandled: () => void;
  finalFocus: React.RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [waitedSeconds, setWaitedSeconds] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // A question asked from outside the sheet (the menu's "Ask the waiter"
  // card, a dish page) is sent once — after the conversation so far has
  // loaded, so it lands below the history rather than above it. Sent from
  // event callbacks (history arriving, the sheet finishing opening), never
  // from an effect body, and de-duplicated by request id because either
  // callback may be the one that finds everything ready.
  const latestPrompt = useRef<PromptRequest | null>(null);
  const handledPromptId = useRef<number | null>(null);
  useEffect(() => {
    latestPrompt.current = promptRequest;
  }, [promptRequest]);

  function deliverPendingPrompt() {
    const request = latestPrompt.current;
    if (!request || handledPromptId.current === request.id) return;
    handledPromptId.current = request.id;
    send(request.text);
    onPromptHandled();
  }

  useEffect(() => {
    if (open && !historyLoaded) {
      getChatHistory().then((history: ChatHistoryEntry[]) => {
        setMessages(history);
        setHistoryLoaded(true);
        deliverPendingPrompt();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliverPendingPrompt reads refs; the fetch must run once per open-before-load, not on every render
  }, [open, historyLoaded]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
  }, [messages, isPending]);

  useEffect(() => {
    if (!isPending) return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      setWaitedSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => {
      window.clearInterval(timer);
      setWaitedSeconds(0);
    };
  }, [isPending]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isPending) return;
    setError(null);
    setVoiceNotice(null);
    setInput("");
    setMessages((prev) => [
      ...prev,
      { id: `local-${Date.now()}`, role: "user", content: trimmed },
    ]);

    startTransition(async () => {
      const result = await sendChatMessage(restaurantSlug, trimmed);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.reply) {
        setMessages((prev) => [
          ...prev,
          {
            id: `reply-${Date.now()}`,
            role: "assistant",
            content: result.reply!,
            recommendations: result.recommendations,
          },
        ]);
      }
      if (result.orderId) {
        router.refresh();
      }
    });
  }

  const showWelcome = historyLoaded && messages.length === 0 && !isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen && historyLoaded) deliverPendingPrompt();
      }}
    >
      <DialogSheetContent initialFocus={inputRef} finalFocus={finalFocus}>
        <header className="flex items-center gap-3 border-b px-5 pt-4 pb-3.5">
          <WaiterAvatar className="size-10" />
          <div className="min-w-0 pr-8">
            <DialogTitle className="type-dish">Your waiter</DialogTitle>
            <DialogDescription className="type-caption text-muted-foreground truncate">
              Answers from {restaurantName}&apos;s menu
            </DialogDescription>
          </div>
        </header>

        {/*
          role="log" + aria-live="polite": a screen reader hears the reply
          when it arrives, without being interrupted mid-sentence.
        */}
        <div
          ref={listRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation with your waiter"
          className="flex-1 overflow-y-auto overscroll-contain px-4 py-5"
        >
          {!historyLoaded && (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <div className="bg-muted h-14 w-3/4 animate-pulse rounded-2xl" />
              <div className="bg-muted ml-auto h-9 w-1/2 animate-pulse rounded-2xl" />
            </div>
          )}

          {showWelcome && (
            <div className="motion-safe:animate-in motion-safe:fade-in-0 flex flex-col items-start gap-4 duration-300">
              <div className="flex flex-col gap-1.5">
                <p className="type-heading">What are you in the mood for?</p>
                <p className="type-body-sm text-muted-foreground">
                  Ask about any dish — what&apos;s in it, how spicy it is, how
                  long it takes — or tell me what you feel like and I&apos;ll
                  suggest a few. I can add dishes to your order too.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {STARTER_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => send(prompt)}
                    className="type-label bg-card hover:bg-secondary focus-visible:ring-ring/50 rounded-full border px-3.5 py-2 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-4">
            {messages.map((message) =>
              message.role === "user" ? (
                <div
                  key={message.id}
                  className="bg-primary text-primary-foreground type-body motion-safe:animate-in motion-safe:fade-in-0 ml-auto max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 break-words whitespace-pre-wrap duration-200"
                >
                  <span className="sr-only">You said: </span>
                  {message.content}
                </div>
              ) : (
                <div
                  key={message.id}
                  className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 flex max-w-[94%] gap-2.5 duration-200"
                >
                  <WaiterAvatar className="mt-0.5 size-7" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                    <div className="bg-ai-soft text-foreground type-body rounded-2xl rounded-tl-md px-3.5 py-2.5 break-words">
                      <span className="sr-only">Your waiter said: </span>
                      <ChatMarkdown source={message.content} />
                    </div>
                    {message.recommendations &&
                      message.recommendations.length > 0 && (
                        <section
                          aria-label="Dishes from this reply"
                          className="flex flex-col gap-2"
                        >
                          <p className="type-overline text-muted-foreground">
                            On the menu
                          </p>
                          {message.recommendations.map((item) => (
                            <RecommendationCard
                              key={item.id}
                              item={item}
                              restaurantSlug={restaurantSlug}
                              onNavigate={() => onOpenChange(false)}
                            />
                          ))}
                        </section>
                      )}
                  </div>
                </div>
              ),
            )}

            {isPending && (
              <div className="flex items-start gap-2.5" role="status">
                <WaiterAvatar className="mt-0.5 size-7" />
                <div className="bg-ai-soft flex flex-col gap-1.5 rounded-2xl rounded-tl-md px-3.5 py-2.5">
                  <span className="text-ai flex gap-1" aria-hidden="true">
                    <span className="size-1.5 rounded-full bg-current [animation-delay:-0.3s] motion-safe:animate-bounce" />
                    <span className="size-1.5 rounded-full bg-current [animation-delay:-0.15s] motion-safe:animate-bounce" />
                    <span className="size-1.5 rounded-full bg-current motion-safe:animate-bounce" />
                  </span>
                  <span className="type-caption text-muted-foreground">
                    {waitingLabel(waitedSeconds)}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p
            className="type-caption text-destructive border-t px-5 pt-2.5"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="border-t px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {/* Above the disclaimer and the composer: the diner who wants a
              person is not going to read either first. */}
          <ServiceRequestButtons />
          <p className="type-caption text-muted-foreground mb-2 px-1">
            Answers come from the restaurant&apos;s menu. For allergies, please
            also check with staff.
          </p>
          {/* Said every time the mic is on, not once in a policy: the
              audio goes to the browser's speech service, not to us. */}
          {(listening || voiceNotice) && (
            <p
              className="type-caption text-muted-foreground mb-2 px-1"
              role="status"
            >
              {listening
                ? "Listening… Your browser's speech service (Google or Apple) turns your voice into text. Tableside only gets the text you send."
                : voiceNotice}
            </p>
          )}
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                listening ? "Listening…" : "Ask about a dish or your order…"
              }
              maxLength={2000}
              disabled={isPending}
              aria-label="Message your waiter"
              enterKeyHint="send"
              className="bg-muted/60 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/40 type-body h-11 min-w-0 flex-1 rounded-full border border-transparent px-4 transition-colors focus-visible:ring-3 focus-visible:outline-none disabled:opacity-60"
            />
            <VoiceInputButton
              value={input}
              onDraft={setInput}
              disabled={isPending}
              onListeningChange={setListening}
              onNotice={setVoiceNotice}
            />
            <button
              type="submit"
              disabled={isPending || !input.trim()}
              aria-label="Send message"
              className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded-full transition-[background-color,opacity] focus-visible:ring-3 focus-visible:outline-none disabled:opacity-40"
            >
              <ArrowUp className="size-5" aria-hidden="true" />
            </button>
          </form>
        </div>
      </DialogSheetContent>
    </Dialog>
  );
}
