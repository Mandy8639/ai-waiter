import type { CSSProperties } from "react";
import { ChefArt } from "@/components/customer/chef-art";
import { KitchenTicket } from "./kitchen-ticket";
import { PlayWhenVisible } from "./play-when-visible";

const delay = (ms: number) => ({ "--mk-delay": `${ms}ms` }) as CSSProperties;

/**
 * The hero's thesis in one picture: a guest asks on their phone, and the
 * answer becomes a ticket in the kitchen. Static markup with CSS-only
 * staging (mk-rise / mk-print), so it costs no JavaScript and shows in
 * full for anyone who prefers reduced motion. Example dishes from the
 * fictional demo restaurant.
 *
 * It stands on a warm "pass" panel with two plated dishes from that
 * restaurant (public/marketing/dishes, copied from its menu so the home
 * page doesn't depend on menu storage), captioned as the demo's own.
 */
export function HeroStage() {
  return (
    <PlayWhenVisible
      className="relative mx-auto w-full max-w-[34rem] pt-6 pb-44 sm:pb-36 lg:pb-24"
      aria-label="Example: a guest asks the Chef for a dish, and the order prints in the kitchen"
      role="img"
    >
      {/* The pass: a warm field the scene stands on. */}
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 bottom-28 overflow-hidden rounded-[2.5rem] sm:bottom-20 lg:bottom-10"
        style={{
          background:
            "radial-gradient(120% 90% at 25% 15%, color-mix(in oklch, var(--primary) 82%, white) 0%, var(--primary) 45%, color-mix(in oklch, var(--primary) 62%, black) 100%)",
        }}
      >
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "radial-gradient(rgb(255 255 255 / 0.10) 1px, transparent 1px)",
            backgroundSize: "14px 14px",
          }}
        />
        {/* Top-left on small screens, where the ticket covers the bottom. */}
        <p className="mk-eyebrow absolute top-3 left-6 flex gap-2 text-[0.6rem] leading-relaxed text-white/70 lg:top-auto lg:bottom-5 lg:flex-col lg:gap-0 lg:text-[0.65rem]">
          <span>Our demo restaurant</span>
          <span className="text-white/90 max-[359px]:hidden">
            Lantern Table
          </span>
        </p>
      </div>

      {/* Plated dishes from the demo's menu. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a small local image, sized here */}
      <img
        src="/marketing/dishes/braised-short-rib.webp"
        alt=""
        width={160}
        height={160}
        className="mk-rise absolute top-16 -left-3 z-0 size-28 rotate-[-10deg] rounded-full shadow-[0_18px_40px_-12px_rgb(0_0_0/0.55)] ring-[6px] ring-white sm:-left-6 sm:size-36"
        style={delay(100)}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- a small local image, sized here */}
      <img
        src="/marketing/dishes/mango-lassi.webp"
        alt=""
        width={120}
        height={120}
        className="mk-rise absolute top-2 -right-2 z-0 size-20 rotate-[8deg] rounded-full shadow-[0_14px_30px_-10px_rgb(0_0_0/0.5)] ring-[5px] ring-white sm:right-2 sm:size-24"
        style={delay(300)}
      />

      <div className="bg-foreground relative z-10 mx-auto mt-6 w-[min(17.5rem,100%)] rounded-[2.6rem] p-2.5 shadow-[0_40px_80px_-30px_rgb(0_0_0/0.65)] sm:w-[19rem]">
        <div className="bg-background flex h-[30rem] flex-col overflow-hidden rounded-[2.1rem] sm:h-[33rem]">
          <div className="flex items-center justify-between border-b px-5 pt-5 pb-3">
            <div>
              <p className="text-[0.95rem] font-semibold">Lantern Table</p>
              <p className="text-muted-foreground text-xs">Table 7</p>
            </div>
            {/* The Chef, as the demo restaurant shows it (CHEF_RESTAURANTS). */}
            <span className="bg-ai-soft text-ai-foreground flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-[0.7rem] font-medium">
              <ChefArt pose="hello" size={22} />
              Ask the Chef
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
              <div className="bg-card text-card-foreground mt-2.5 flex items-center gap-2.5 rounded-xl border p-1.5 pr-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- a small local image, sized here */}
                <img
                  src="/marketing/dishes/braised-short-rib.webp"
                  alt=""
                  width={36}
                  height={36}
                  className="size-9 rounded-lg object-cover"
                />
                <span className="flex-1 font-medium">Braised Short Rib</span>
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
        className="mk-print absolute right-0 bottom-0 z-20 rotate-[4deg] sm:-right-4"
        style={delay(2700)}
        table="TABLE 7"
        orderNumber={142}
        time="7:42 PM"
        lines={[
          { qty: 1, name: "Braised short rib", note: "no greens" },
          { qty: 1, name: "Ginger lemonade" },
        ]}
        footer="— sent by the Chef —"
      />
    </PlayWhenVisible>
  );
}
