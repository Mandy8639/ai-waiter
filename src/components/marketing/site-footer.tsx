import Link from "next/link";
import { FOOTER_GROUPS } from "@/lib/marketing/content";
import { LEGAL_ENTITY } from "@/lib/legal/terms";
import { Wordmark } from "./wordmark";

export function SiteFooter() {
  return (
    <footer className="dark bg-background text-foreground">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <div className="flex flex-col gap-4">
          <Wordmark />
          <p className="text-muted-foreground max-w-xs text-sm">
            Ordering at the table, with a waiter that knows your menu.
          </p>
          <p className="text-muted-foreground text-sm">
            At a restaurant? Scan the code on your table to see the menu.
          </p>
        </div>
        {FOOTER_GROUPS.map((group) => (
          <nav key={group.title} aria-label={group.title}>
            <h2 className="mk-eyebrow text-muted-foreground mb-3">
              {group.title}
            </h2>
            <ul className="flex flex-col gap-2 text-sm">
              {group.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="underline-offset-4 hover:underline"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="text-muted-foreground border-t">
        <p className="mx-auto w-full max-w-6xl px-4 py-5 text-xs sm:px-6">
          © {new Date().getFullYear()} {LEGAL_ENTITY}
        </p>
      </div>
    </footer>
  );
}
