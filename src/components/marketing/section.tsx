import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A full-width band with the site's content width and vertical rhythm. */
export function Section({
  children,
  className,
  innerClassName,
  id,
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  innerClassName?: string;
  id?: string;
  labelledBy?: string;
}) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={className}>
      <div
        className={cn(
          "mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28",
          innerClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** Eyebrow, display headline and an optional lead paragraph. */
export function SectionHeading({
  id,
  eyebrow,
  title,
  lead,
  className,
}: {
  id?: string;
  eyebrow: string;
  title: ReactNode;
  lead?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex max-w-2xl flex-col gap-4", className)}>
      <p className="mk-eyebrow text-primary dark:text-[var(--ai)]">{eyebrow}</p>
      <h2 id={id} className="mk-display text-4xl sm:text-5xl">
        {title}
      </h2>
      {lead ? (
        <p className="text-muted-foreground text-lg text-pretty">{lead}</p>
      ) : null}
    </div>
  );
}
