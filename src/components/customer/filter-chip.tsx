import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * A chip that is a link — categories and dietary filters are URL state, so
 * they work without JavaScript, survive a refresh and can be shared.
 *
 * `aria-current` marks the selected one for assistive tech; the visual
 * state follows the same flag so the two can never disagree.
 */
export function FilterChip({
  href,
  active,
  children,
  icon,
  scroll = false,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
  icon?: React.ReactNode;
  /** Filter changes keep the scroll position by default. */
  scroll?: boolean;
}) {
  return (
    <Link
      href={href}
      scroll={scroll}
      aria-current={active ? "true" : undefined}
      className={cn(
        "type-label inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 whitespace-nowrap transition-colors duration-150",
        "focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none",
        active
          ? "bg-foreground text-background border-transparent"
          : "bg-card text-foreground hover:bg-secondary border-border",
      )}
    >
      {icon}
      {children}
    </Link>
  );
}
