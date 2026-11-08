import { Smartphone } from "lucide-react";
import { STAFF_APP } from "@/lib/marketing/content";
import { cn } from "@/lib/utils";

/**
 * Links to the staff app in both stores. Plain labelled buttons rather
 * than Apple's and Google's badge artwork, which comes with its own usage
 * rules; the words say the same thing.
 */
export function StoreLinks({
  tone = "light",
  className,
}: {
  /** "dark" for use on the dark sections. */
  tone?: "light" | "dark";
  className?: string;
}) {
  const style = cn(
    "inline-flex h-10 items-center gap-2 rounded-xl border px-3.5 text-sm font-medium transition-colors",
    tone === "dark"
      ? "border-white/25 text-white hover:bg-white/10"
      : "bg-card hover:bg-secondary",
  );
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      <a href={STAFF_APP.appStore} className={style} rel="noopener">
        <Smartphone className="size-4" aria-hidden="true" />
        <span>
          <span className="sr-only">Staff app on the </span>App Store
        </span>
      </a>
      <a href={STAFF_APP.googlePlay} className={style} rel="noopener">
        <Smartphone className="size-4" aria-hidden="true" />
        <span>
          <span className="sr-only">Staff app on </span>Google Play
        </span>
      </a>
    </div>
  );
}
