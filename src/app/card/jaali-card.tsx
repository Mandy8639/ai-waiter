import { BUSINESS_CARD as card } from "@/lib/marketing/business-card";

/**
 * The front of the printed visiting card (the "jaali" design), drawn in
 * HTML so the page that the card's QR opens shows the same card. Fixed brand
 * colours, not theme tokens: it's a replica of a printed object, so it looks
 * the same in light and dark mode. Everything scales with the card's width
 * (container query units), keeping the printed 3.5 × 2 in proportions.
 */
const BROWN = "#842B02";
const CREAM = "#FDFAF6";
const TURMERIC = "#BF7B1F";
// Quatrefoil jaali: circles on a square grid, radius = grid / √2.
const GRID = 17;
const R = GRID / Math.SQRT2;

export function JaaliCard() {
  return (
    <div
      className="@container relative aspect-[7/4] w-full overflow-hidden rounded-2xl shadow-sm"
      style={{ backgroundColor: BROWN, color: CREAM }}
    >
      <svg
        aria-hidden
        className="absolute inset-0 size-full"
        viewBox="0 0 350 200"
        preserveAspectRatio="xMidYMid slice"
      >
        <defs>
          <pattern
            id="jaali"
            width={GRID}
            height={GRID}
            patternUnits="userSpaceOnUse"
          >
            {[
              [0, 0],
              [GRID, 0],
              [0, GRID],
              [GRID, GRID],
            ].map(([cx, cy]) => (
              <circle
                key={`${cx}-${cy}`}
                cx={cx}
                cy={cy}
                r={R}
                fill="none"
                stroke={TURMERIC}
                strokeWidth={0.45}
              />
            ))}
          </pattern>
        </defs>
        <rect width="350" height="200" fill="url(#jaali)" opacity={0.28} />
      </svg>

      <div className="relative flex size-full flex-col items-center justify-center text-center">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static brand SVG */}
        <img
          src="/brand/tableside-mark-white.svg"
          alt=""
          width={652}
          height={562}
          className="h-auto w-[10cqw]"
        />
        <p className="mk-display mt-[2cqw] text-[10.5cqw] leading-none">
          Tableside
        </p>
        <p className="mk-display mt-[1.6cqw] text-[4.6cqw] leading-tight italic">
          The menu that answers.
        </p>
        <span
          aria-hidden
          className="mt-[3.4cqw] block h-px w-[9cqw]"
          style={{ backgroundColor: TURMERIC }}
        />
        <h1 className="mk-display mt-[3.2cqw] text-[5.4cqw] leading-tight">
          {card.name}
        </h1>
        <p className="mt-[0.8cqw] text-[max(9px,2.6cqw)] font-medium tracking-[0.2em] uppercase">
          {card.title}
        </p>
      </div>
    </div>
  );
}
