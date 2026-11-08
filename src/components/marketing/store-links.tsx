import { STAFF_APP } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";

/**
 * The staff app's store badges, the official artwork, unaltered:
 * Apple's "Download on the App Store" (developer.apple.com) and Google's
 * "Get it on Google Play" (play.google.com/intl/en_us/badges), with only
 * the transparent margin trimmed from Google's PNG so the two can sit at
 * the same height. Apple asks for at least 40px tall on screen. The
 * trademark notice both ask for is in the footer (STORE_TRADEMARKS).
 */
export function StoreLinks({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <a
        href={STAFF_APP.appStore}
        rel="noopener"
        className="rounded-[9px] transition-opacity hover:opacity-85"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Apple's badge SVG, as supplied */}
        <img
          src="/marketing/badges/app-store.svg"
          alt="Download on the App Store"
          width={120}
          height={40}
          className="h-10 w-auto"
        />
      </a>
      <a
        href={STAFF_APP.googlePlay}
        rel="noopener"
        className="rounded-[7px] transition-opacity hover:opacity-85"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- Google's badge, as supplied */}
        <img
          src="/marketing/badges/google-play.png"
          alt="Get it on Google Play"
          width={134}
          height={40}
          className="h-10 w-auto"
        />
      </a>
    </div>
  );
}
