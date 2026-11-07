import type { ReactNode } from "react";

/** The top of an inner marketing page: eyebrow, display title, lead. */
export function PageHero({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lead: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="mk-paper border-b">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-4 pt-16 pb-16 sm:px-6 sm:pt-24 sm:pb-20">
        <p className="mk-eyebrow text-primary">{eyebrow}</p>
        <h1 className="mk-display max-w-3xl text-5xl sm:text-7xl">{title}</h1>
        <p className="text-muted-foreground max-w-2xl text-lg text-pretty">
          {lead}
        </p>
        {children}
      </div>
    </section>
  );
}
