"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages } from "lucide-react";
import { setMenuLanguage } from "@/lib/translations/actions";
import { languageInfo, type MenuLanguage } from "@/lib/translations/languages";
import { cn } from "@/lib/utils";

/**
 * Read the menu in another language (phase K). Offered only for languages
 * the restaurant has approved translations in; "Original" is the menu as
 * the restaurant wrote it. Remembered for the visit (a cookie), so the dish
 * pages follow.
 */
export function MenuLanguagePicker({
  current,
  available,
}: {
  current: MenuLanguage | null;
  available: MenuLanguage[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  if (available.length === 0) return null;

  // A dropped connection must not throw to the error page and take the
  // whole menu with it: the menu stays as it was, with a line saying so.
  const choose = (code: string) =>
    start(async () => {
      setFailed(false);
      try {
        await setMenuLanguage(code);
        router.refresh();
      } catch {
        setFailed(true);
      }
    });

  const options = [
    { code: "original", label: "Original" },
    ...available.map((code) => ({ code, label: languageInfo(code).native })),
  ];

  return (
    <div
      role="group"
      aria-label="Menu language"
      className={cn(
        "flex flex-wrap items-center gap-2",
        pending && "opacity-60",
      )}
    >
      <Languages className="text-muted-foreground size-4" aria-hidden="true" />
      {options.map((o) => {
        const selected =
          o.code === "original" ? current === null : current === o.code;
        return (
          <button
            key={o.code}
            type="button"
            lang={o.code === "original" ? undefined : o.code}
            aria-pressed={selected}
            disabled={pending}
            onClick={() => choose(o.code)}
            className={cn(
              "type-label rounded-full border px-3 py-1 transition-colors",
              selected
                ? "bg-foreground text-background border-transparent"
                : "bg-card hover:bg-muted",
            )}
          >
            {o.label}
          </button>
        );
      })}
      {failed && (
        <p role="alert" className="text-destructive type-caption w-full">
          Couldn&apos;t change the language. Check your connection and try
          again.
        </p>
      )}
    </div>
  );
}
