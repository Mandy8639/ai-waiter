import type { CSSProperties } from "react";
import { Sparkles } from "lucide-react";
import { KitchenTicket } from "./kitchen-ticket";
import { PlayWhenVisible } from "./play-when-visible";

const delay = (ms: number) => ({ "--mk-delay": `${ms}ms` }) as CSSProperties;

/**
 * The hero's thesis in one picture: a guest asks on their phone, and the
 * answer becomes a ticket in the kitchen. Static markup with CSS-only
 * staging (mk-rise / mk-print), so it costs no JavaScript and shows in
 * full for anyone who prefers reduced motion. Example dishes from the
 * fictional demo restaurant.
 */
export function HeroStage() {
  return (
    <PlayWhenVisible
      className="relative mx-auto w-full max-w-[28rem] pb-44 sm:pb-36 lg:pb-24"
      aria-label="Example: a guest asks the waiter for a dish, and the order prints in the kitchen"
      role="img"
    >
      <div className="bg-foreground relative mx-auto w-[17.5rem] rounded-[2.6rem] p-2.5 shadow-[var(--shadow-float)] sm:mx-0 sm:w-[19rem]">
        <div className="bg-background flex h-[30rem] flex-col overflow-hidden rounded-[2.1rem] sm:h-[33rem]">
          <div className="flex items-center justify-between border-b px-5 pt-5 pb-3">
            <div>
              <p className="text-[0.95rem] font-semibold">Lantern Table</p>
              <p className="text-muted-foreground text-xs">Table 7</p>
            </div>
            <span className="bg-ai-soft text-ai-foreground flex items-center gap-1 rounded-full px-2.5 py-1 text-[0.7rem] font-medium">
              <Sparkles className="size-3" aria-hidden />
              Waiter
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-3 px-4 py-4 text-[0.82rem] leading-snug">
            <p
              className="mk-rise bg-primary text-primary-foreground ml-auto max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2"
              style={delay(200)}
            >
              Something filling, not too spicy?
            </p>
            <div
              className="mk-rise bg-ai-soft text-ai-foreground max-w-[88%] rounded-2xl rounded-bl-md px-3.5 py-2.5"
              style={delay(800)}
            >
              The Braised Short Rib is the heartiest dish here, and it&apos;s
              mild. It comes with mash and greens.
              <div className="bg-card text-card-foreground mt-2.5 flex items-center justify-between rounded-xl border px-3 py-2">
                <span className="font-medium">Braised Short Rib</span>
                <span className="type-price">$24</span>
              </div>
            </div>
            <p
              className="mk-rise bg-primary text-primary-foreground ml-auto max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2"
              style={delay(1500)}
            >
              One of those, no greens please.
            </p>
            <p
              className="mk-rise bg-ai-soft text-ai-foreground max-w-[88%] rounded-2xl rounded-bl-md px-3.5 py-2"
              style={delay(2100)}
            >
              Done: Braised Short Rib, no greens. It&apos;s on its way to the
              kitchen.
            </p>
          </div>
        </div>
      </div>

      <KitchenTicket
        className="mk-print absolute right-0 bottom-0 rotate-[4deg] sm:-right-4"
        style={delay(2700)}
        table="TABLE 7"
        orderNumber={142}
        time="7:42 PM"
        lines={[
          { qty: 1, name: "Braised short rib", note: "no greens" },
          { qty: 1, name: "Ginger lemonade" },
        ]}
        footer="— sent by the waiter —"
      />
    </PlayWhenVisible>
  );
}
