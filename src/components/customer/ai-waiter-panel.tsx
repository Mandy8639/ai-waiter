"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  getChatHistory,
  sendChatMessage,
  type ChatHistoryEntry,
} from "@/lib/ai/actions";

const QUICK_ACTIONS = [
  "Show vegetarian options",
  "What do you recommend?",
  "Show spicy dishes",
  "What's in my cart?",
  "Where is my order?",
];

interface DisplayMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/**
 * Renders every message as plain text (React escapes string children by
 * default; nothing here ever uses dangerouslySetInnerHTML or interprets
 * model output as HTML/markdown-with-links) — spec section 37. Newlines
 * are preserved with CSS (`whitespace-pre-wrap`), not by parsing the
 * content into markup.
 */
export function AiWaiterPanel({
  restaurantSlug,
  open,
  onOpenChange,
}: {
  restaurantSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && !historyLoaded) {
      getChatHistory().then((history: ChatHistoryEntry[]) => {
        setMessages(history);
        setHistoryLoaded(true);
      });
    }
  }, [open, historyLoaded]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, isPending]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || isPending) return;
    setError(null);
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
          },
        ]);
      }
      if (result.orderId) {
        router.refresh();
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[720px] flex-col p-0 sm:h-[600px]">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>AI Waiter</DialogTitle>
        </DialogHeader>

        <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3">
          {messages.length === 0 && historyLoaded && (
            <p className="text-muted-foreground py-6 text-center text-sm">
              Ask about the menu, build your order, or check on one already
              placed.
            </p>
          )}
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === "user"
                    ? "bg-primary text-primary-foreground ml-auto max-w-[85%] rounded-2xl rounded-br-sm px-3 py-2 text-sm whitespace-pre-wrap"
                    : "bg-muted mr-auto max-w-[85%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm whitespace-pre-wrap"
                }
              >
                {message.content}
              </div>
            ))}
            {isPending && (
              <div
                className="bg-muted text-muted-foreground mr-auto flex items-center gap-1 rounded-2xl rounded-bl-sm px-3 py-2 text-sm"
                role="status"
                aria-label="AI waiter is typing"
              >
                <span className="sr-only">Thinking…</span>
                <span className="flex gap-1" aria-hidden="true">
                  <span className="size-1.5 rounded-full bg-current [animation-delay:-0.3s] motion-safe:animate-bounce" />
                  <span className="size-1.5 rounded-full bg-current [animation-delay:-0.15s] motion-safe:animate-bounce" />
                  <span className="size-1.5 rounded-full bg-current motion-safe:animate-bounce" />
                </span>
              </div>
            )}
          </div>
        </div>

        {error && (
          <p className="text-destructive px-4 pb-1 text-xs" role="alert">
            {error}
          </p>
        )}

        {messages.length === 0 && (
          <div className="flex flex-wrap gap-1.5 px-4 pb-2">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action}
                type="button"
                onClick={() => send(action)}
                disabled={isPending}
                className="border-input hover:bg-accent rounded-full border px-2.5 py-1 text-xs"
              >
                {action}
              </button>
            ))}
          </div>
        )}

        <form
          className="flex items-center gap-2 border-t p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about the menu or your order…"
            maxLength={2000}
            disabled={isPending}
            aria-label="Message the AI waiter"
            className="flex-1"
          />
          <Button type="submit" disabled={isPending || !input.trim()}>
            Send
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
