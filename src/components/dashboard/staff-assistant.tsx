"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { usePathname } from "next/navigation";
import { ArrowUp } from "lucide-react";
import {
  Dialog,
  DialogDescription,
  DialogSheetContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChefArt } from "@/components/customer/chef-art";
import { cn } from "@/lib/utils";
import {
  applyStaffAction,
  sendStaffCommand,
} from "@/lib/staff-assistant/actions";
import { MAX_COMMAND_LENGTH } from "@/lib/staff-assistant/intent";
import { staffChefMoment } from "@/lib/staff-assistant/chef-core";
import type {
  AssistantReply,
  ReplyButton,
} from "@/lib/staff-assistant/plan-core";

/**
 * The staff assistant, as the Chef: the same character diners meet, here
 * as the kitchen's helper. "Ask the Chef" floats on every dashboard page
 * for owners, managers and the kitchen, and opens the same slide-up chat
 * diners get; /dashboard/assistant shows the same conversation full-page
 * (the kitchen tablet's tab). One conversation, held here, so it carries
 * on from page to page and between the two.
 *
 * Type what you'd say to a manager ("86 the salmon", "pause ordering for
 * an hour") and it's done through the same switches as the Sold out and
 * Kitchen pages. Prices, and anything it had to guess at, ask first; a
 * name that matches several things asks which.
 */

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

interface StaffAssistantValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  messages: Message[];
  pending: boolean;
  canChangePrices: boolean;
  send: (text: string) => void;
  press: (button: ReplyButton) => void;
  cancel: () => void;
}

const StaffAssistantContext = createContext<StaffAssistantValue | null>(null);

const EXAMPLES = [
  "86 the salmon",
  "Pause ordering for an hour",
  "We're slammed, add 15 minutes",
  "What's sold out?",
];

const YES = /^(y|yes|yep|yeah|yup|sure|ok|okay|do it|go ahead|confirm)$/i;
const NO = /^(n|no|nope|cancel|stop|never ?mind)$/i;

/** The page that shows the conversation full-page, where the floating Chef would be a second copy. */
export const ASSISTANT_PATH = "/dashboard/assistant";

export function StaffAssistantProvider({
  restaurantId,
  canChangePrices,
  children,
}: {
  restaurantId: string;
  canChangePrices: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pending, start] = useTransition();
  const nextId = useRef(1);

  const add = useCallback((m: Omit<Message, "id">) => {
    setMessages((prev) => [...prev, { ...m, id: nextId.current++ }]);
  }, []);

  /** Earlier questions can't be answered once something newer is said. */
  const settleAll = useCallback(() => {
    setMessages((prev) =>
      prev.map((m) => (m.buttons?.length ? { ...m, settled: true } : m)),
    );
  }, []);

  const show = useCallback(
    (reply: AssistantReply) =>
      add({
        from: "assistant",
        text: reply.text,
        tone: reply.tone,
        buttons: reply.buttons,
        cancellable: reply.cancellable,
      }),
    [add],
  );

  const press = useCallback(
    (button: ReplyButton) => {
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
    },
    [add, restaurantId, settleAll, show],
  );

  const cancel = useCallback(() => {
    settleAll();
    add({ from: "you", text: "No" });
    add({
      from: "assistant",
      text: "Okay, nothing was changed.",
      tone: "info",
    });
  }, [add, settleAll]);

  const send = useCallback(
    (raw: string) => {
      const command = raw.trim();
      if (!command || pending) return;

      // "yes" / "no" answer the open question, when there's exactly one
      // button to say yes to.
      const openQuestion = [...messages]
        .reverse()
        .find((m) => m.from === "assistant" && m.cancellable && !m.settled);
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
    },
    [add, cancel, messages, pending, press, restaurantId, settleAll, show],
  );

  return (
    <StaffAssistantContext.Provider
      value={{
        open,
        setOpen,
        messages,
        pending,
        canChangePrices,
        send,
        press,
        cancel,
      }}
    >
      {children}
      <StaffChefDock />
      <StaffChefSheet />
    </StaffAssistantContext.Provider>
  );
}

/** "Ask the Chef", floating bottom-right like the diner's, on every page but the Assistant page itself. */
function StaffChefDock() {
  const ctx = useContext(StaffAssistantContext);
  const pathname = usePathname();
  const openerRef = useRef<HTMLButtonElement>(null);
  if (!ctx || pathname === ASSISTANT_PATH) return null;

  return (
    <div className="pointer-events-none fixed right-0 bottom-0 z-30 pr-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pr-6 print:hidden">
      <button
        ref={openerRef}
        type="button"
        onClick={() => ctx.setOpen(true)}
        className="bg-foreground text-background hover:bg-foreground/90 shadow-float focus-visible:ring-ring/50 pointer-events-auto flex h-12 items-center gap-2 rounded-full px-4 transition-[transform,background-color] duration-150 focus-visible:ring-3 focus-visible:outline-none active:scale-[0.98]"
      >
        <span className="bg-card flex size-7 items-center justify-center overflow-hidden rounded-full">
          <ChefArt pose="neutral" size={28} />
        </span>
        <span className="type-label text-[0.9375rem] font-semibold whitespace-nowrap">
          Ask the Chef
        </span>
      </button>
    </div>
  );
}

function StaffChefSheet() {
  const ctx = useContext(StaffAssistantContext);
  const inputRef = useRef<HTMLInputElement>(null);
  if (!ctx) return null;
  return (
    <Dialog open={ctx.open} onOpenChange={ctx.setOpen}>
      <DialogSheetContent initialFocus={inputRef}>
        <ChefHeader />
        <StaffChefConversation inputRef={inputRef} />
      </DialogSheetContent>
    </Dialog>
  );
}

function ChefHeader({ asPage = false }: { asPage?: boolean }) {
  const Title = asPage ? "h2" : DialogTitle;
  const Description = asPage ? "p" : DialogDescription;
  return (
    <header className="flex items-center gap-3 border-b px-5 pt-4 pb-3.5">
      <ChefArt pose="neutral" size={40} />
      <div className="min-w-0 pr-8">
        <Title className="type-dish">Chef</Title>
        <Description className="type-caption text-muted-foreground truncate">
          Your kitchen assistant
        </Description>
      </div>
    </header>
  );
}

/** The full-page version, for /dashboard/assistant (the kitchen tablet's tab). */
export function StaffAssistantPanel() {
  const ctx = useContext(StaffAssistantContext);
  if (!ctx) return null;
  return (
    <div className="bg-popover flex h-[min(720px,calc(100dvh-10rem))] min-h-[28rem] flex-col overflow-hidden rounded-2xl border">
      <ChefHeader asPage />
      <StaffChefConversation />
    </div>
  );
}

function StaffChefConversation({
  inputRef,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
}) {
  const ctx = useContext(StaffAssistantContext)!;
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const { messages, pending } = ctx;
  const moment = staffChefMoment({ pending, messages });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)")
      .matches;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, [messages, pending]);

  function submit(value: string) {
    if (!value.trim() || pending) return;
    setText("");
    ctx.send(value);
  }

  return (
    <>
      {/* role="log" + aria-live="polite": a screen reader hears each reply when it arrives. */}
      <div
        ref={listRef}
        role="log"
        aria-live="polite"
        aria-label="Conversation with the Chef"
        className="flex-1 overflow-y-auto overscroll-contain px-4 py-5"
      >
        {moment.placement === "welcome" && (
          <div className="motion-safe:animate-in motion-safe:fade-in-0 mb-4 flex flex-col items-start gap-4 duration-300">
            <div className="flex items-end gap-3">
              <ChefArt pose="hello" size={96} crop="full" motion="wave" />
              <div className="flex flex-col gap-1.5 pb-1">
                <p className="type-heading">
                  What&apos;s changed in the kitchen?
                </p>
                <p className="type-body-sm text-muted-foreground">
                  Tell me what&apos;s run out or come back, or pause ordering.
                  {ctx.canChangePrices &&
                    " I can change prices too, after you say yes."}{" "}
                  Type &ldquo;help&rdquo; for everything I can do.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => submit(e)}
                  className="type-label bg-card hover:bg-secondary focus-visible:ring-ring/50 rounded-full border px-3.5 py-2 text-left transition-colors focus-visible:ring-3 focus-visible:outline-none"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-4">
          {messages.map((m, index) =>
            m.from === "you" ? (
              <div
                key={m.id}
                className="bg-primary text-primary-foreground type-body motion-safe:animate-in motion-safe:fade-in-0 ml-auto max-w-[85%] rounded-2xl rounded-br-md px-3.5 py-2.5 break-words whitespace-pre-wrap duration-200"
              >
                <span className="sr-only">You said: </span>
                {m.text}
              </div>
            ) : (
              <div
                key={m.id}
                className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 flex max-w-[94%] gap-2.5 duration-200"
              >
                {moment.placement === "reply" &&
                  moment.messageIndex === index && (
                    <ChefArt
                      key={`${m.id}-${moment.pose}`}
                      pose={moment.pose}
                      size={36}
                      motion={moment.motion}
                      className="mt-0.5"
                    />
                  )}
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p
                    className={cn(
                      "type-body rounded-2xl rounded-tl-md px-3.5 py-2.5 break-words whitespace-pre-line",
                      m.tone === "done"
                        ? "border border-emerald-600/30 bg-emerald-600/10"
                        : m.tone === "error"
                          ? "border-destructive/30 bg-destructive/10 border"
                          : "bg-ai-soft text-foreground",
                    )}
                  >
                    <span className="sr-only">Chef said: </span>
                    {m.text}
                  </p>
                  {!m.settled &&
                    ((m.buttons?.length ?? 0) > 0 || m.cancellable) && (
                      <div className="flex flex-wrap gap-2">
                        {m.buttons?.map((b, i) => (
                          <button
                            key={i}
                            type="button"
                            disabled={pending}
                            onClick={() => ctx.press(b)}
                            className={cn(
                              "type-label focus-visible:ring-ring/50 min-h-10 rounded-full px-4 transition-colors focus-visible:ring-3 focus-visible:outline-none disabled:opacity-50",
                              b.variant === "primary"
                                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                : "bg-card hover:bg-secondary border",
                            )}
                          >
                            {b.label}
                          </button>
                        ))}
                        {m.cancellable && (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={ctx.cancel}
                            className="type-label text-muted-foreground hover:bg-muted min-h-10 rounded-full px-4 disabled:opacity-50"
                          >
                            {m.buttons && m.buttons.length > 1
                              ? "None of these"
                              : "No"}
                          </button>
                        )}
                      </div>
                    )}
                </div>
              </div>
            ),
          )}

          {moment.placement === "thinking" && (
            <div className="flex items-center gap-3" role="status">
              <ChefArt
                pose={moment.pose}
                size={80}
                crop="full"
                motion={moment.motion}
              />
              <span className="type-body-sm text-muted-foreground">On it…</span>
            </div>
          )}
        </div>
      </div>

      <div className="border-t px-4 pt-2.5 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <p className="type-caption text-muted-foreground mb-2 px-1">
          Changes happen straight away, with an undo. Prices ask first.
        </p>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={MAX_COMMAND_LENGTH}
            placeholder="e.g. 86 the salmon"
            aria-label="Message the Chef"
            autoComplete="off"
            enterKeyHint="send"
            className="bg-muted/60 placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/40 type-body h-11 min-w-0 flex-1 rounded-full border border-transparent px-4 transition-colors focus-visible:ring-3 focus-visible:outline-none"
          />
          <button
            type="submit"
            disabled={pending || !text.trim()}
            aria-label="Send message"
            className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring/50 flex size-11 shrink-0 items-center justify-center rounded-full transition-[background-color,opacity] focus-visible:ring-3 focus-visible:outline-none disabled:opacity-40"
          >
            <ArrowUp className="size-5" aria-hidden="true" />
          </button>
        </form>
      </div>
    </>
  );
}
