"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  applyStaffAction,
  sendStaffCommand,
} from "@/lib/staff-assistant/actions";
import { MAX_COMMAND_LENGTH } from "@/lib/staff-assistant/intent";
import type {
  AssistantReply,
  ReplyButton,
} from "@/lib/staff-assistant/plan-core";

interface Message {
  id: number;
  from: "you" | "assistant";
  text: string;
  tone?: AssistantReply["tone"];
  buttons?: ReplyButton[];
  cancellable?: boolean;
  /** Buttons stop working once used or superseded. */
  settled?: boolean;
}

const EXAMPLES = [
  "86 the salmon",
  "Pause ordering for an hour",
  "We're slammed, add 15 minutes",
  "What's sold out?",
];

const YES = /^(y|yes|yep|yeah|yup|sure|ok|okay|do it|go ahead|confirm)$/i;
const NO = /^(n|no|nope|cancel|stop|never ?mind)$/i;

/**
 * The staff assistant: type what you'd say to a manager ("86 the salmon",
 * "pause ordering for an hour") and it's done, through the same switches
 * as the Sold out and Kitchen pages. Prices and anything it had to guess
 * at ask first; a name that matches several things asks which.
 */
export function StaffAssistant({
  restaurantId,
  canChangePrices,
}: {
  restaurantId: string;
  canChangePrices: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 0,
      from: "assistant",
      text: `Tell me what's changed. For example "86 the salmon", "the oat milk is out" or "pause ordering for an hour".${canChangePrices ? ' I can change prices too ("make the mango lassi $5.50"), after you say yes.' : ""} Type "help" for everything I can do.`,
      tone: "info",
    },
  ]);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const nextId = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const add = (m: Omit<Message, "id">) =>
    setMessages((prev) => [...prev, { ...m, id: nextId.current++ }]);

  /** Earlier questions can't be answered once something newer is said. */
  const settleAll = () =>
    setMessages((prev) =>
      prev.map((m) => (m.buttons?.length ? { ...m, settled: true } : m)),
    );

  const show = (reply: AssistantReply) =>
    add({
      from: "assistant",
      text: reply.text,
      tone: reply.tone,
      buttons: reply.buttons,
      cancellable: reply.cancellable,
    });

  const openQuestion = [...messages]
    .reverse()
    .find((m) => m.from === "assistant" && m.cancellable && !m.settled);

  function press(button: ReplyButton) {
    settleAll();
    add({ from: "you", text: button.label });
    start(async () => {
      show(
        await applyStaffAction(
          restaurantId,
          button.action,
          button.confirmed,
          button.label,
        ),
      );
    });
  }

  function cancel() {
    settleAll();
    add({ from: "you", text: "No" });
    add({
      from: "assistant",
      text: "Okay, nothing was changed.",
      tone: "info",
    });
  }

  function send(raw: string) {
    const command = raw.trim();
    if (!command || pending) return;
    setText("");

    // "yes" / "no" answer the open question, when there's exactly one
    // button to say yes to.
    if (openQuestion) {
      const yesButton =
        openQuestion.buttons?.length === 1 ? openQuestion.buttons[0] : null;
      if (YES.test(command) && yesButton) return press(yesButton);
      if (NO.test(command)) return cancel();
    }

    settleAll();
    add({ from: "you", text: command });
    start(async () => {
      show(await sendStaffCommand(restaurantId, command));
    });
  }

  return (
    <div className="flex min-h-[60vh] flex-col rounded-xl border">
      <div
        role="log"
        aria-live="polite"
        aria-label="Conversation with the assistant"
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              "flex flex-col gap-2",
              m.from === "you" ? "items-end" : "items-start",
            )}
          >
            <p
              className={cn(
                "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-line",
                m.from === "you"
                  ? "bg-primary text-primary-foreground"
                  : m.tone === "done"
                    ? "border border-emerald-600/30 bg-emerald-600/10"
                    : m.tone === "error"
                      ? "border-destructive/30 bg-destructive/10 border"
                      : "bg-muted",
              )}
            >
              <span className="sr-only">
                {m.from === "you" ? "You: " : "Assistant: "}
              </span>
              {m.text}
            </p>
            {m.from === "assistant" &&
              !m.settled &&
              ((m.buttons?.length ?? 0) > 0 || m.cancellable) && (
                <div className="flex flex-wrap gap-2">
                  {m.buttons?.map((b, i) => (
                    <Button
                      key={i}
                      type="button"
                      size="sm"
                      variant={b.variant === "primary" ? "default" : "outline"}
                      disabled={pending}
                      onClick={() => press(b)}
                    >
                      {b.label}
                    </Button>
                  ))}
                  {m.cancellable && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={cancel}
                    >
                      {m.buttons && m.buttons.length > 1
                        ? "None of these"
                        : "No"}
                    </Button>
                  )}
                </div>
              )}
          </div>
        ))}
        {pending && (
          <p className="text-muted-foreground text-sm" aria-live="polite">
            Working on it…
          </p>
        )}
        <div ref={endRef} />
      </div>

      <div className="flex flex-col gap-2 border-t p-3">
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              type="button"
              disabled={pending}
              onClick={() => setText(e)}
              className="hover:bg-muted rounded-full border px-3 py-1 text-xs"
            >
              {e}
            </button>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_COMMAND_LENGTH}
            placeholder="Type a command, e.g. 86 the salmon"
            aria-label="Command for the assistant"
            autoComplete="off"
            className="h-11 text-base"
          />
          <Button
            type="submit"
            className="h-11"
            disabled={pending || !text.trim()}
            aria-label="Send"
          >
            <SendHorizontal className="size-4" aria-hidden="true" />
          </Button>
        </form>
      </div>
    </div>
  );
}
