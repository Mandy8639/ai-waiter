import { cn } from "@/lib/utils";

/** The table mark and the name, set in the display face. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a tiny static SVG; next/image adds nothing */}
      <img
        src="/brand/tableside-mark.svg"
        alt=""
        width={30}
        height={26}
        className="h-[26px] w-auto dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- as above */}
      <img
        src="/brand/tableside-mark-white.svg"
        alt=""
        width={30}
        height={26}
        className="hidden h-[26px] w-auto dark:block"
      />
      <span className="mk-display text-[1.6rem] leading-none">Tableside</span>
    </span>
  );
}
