import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { TranslationWorkbench } from "@/components/dashboard/translation-workbench";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { getTranslationWorkbench } from "@/lib/translations/queries";
import {
  MENU_LANGUAGES,
  isMenuLanguage,
  type MenuLanguage,
} from "@/lib/translations/languages";

// "Draft with AI" runs on this page and waits on a free model that can
// take most of a minute per batch (src/lib/ai/free-draft-core.ts).
export const maxDuration = 120;

export const metadata = {
  title: "Menu translations — Tableside",
};

/**
 * Phase K: translate the menu. Owners and managers only; the page doesn't
 * exist for anyone else (the database refuses them regardless).
 */
export default async function MenuTranslationsPage({
  searchParams,
}: {
  searchParams: Promise<{ lang?: string }>;
}) {
  const { restaurant } = await requireCurrentRestaurant();
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    notFound();
  }

  const { lang } = await searchParams;
  const language: MenuLanguage = isMenuLanguage(lang) ? lang : "hi";
  const rows = await getTranslationWorkbench(restaurant.id, language);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/dashboard/menu"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Menu
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          Menu translations
        </h1>
        <p className="text-muted-foreground text-sm">
          Diners can read your menu in their own language. The AI drafts, you
          approve: nothing is shown to diners until you approve it, and a
          translation stops showing when you change the original. Allergens and
          dietary labels always stay in English, with a fixed translation beside
          them.
        </p>
      </div>

      <nav aria-label="Language" className="flex flex-wrap gap-2">
        {MENU_LANGUAGES.map((l) => (
          <Link
            key={l.code}
            href={`/dashboard/menu/translations?lang=${l.code}`}
            aria-current={l.code === language ? "page" : undefined}
            className={
              "rounded-full border px-3 py-1.5 text-sm " +
              (l.code === language
                ? "bg-primary text-primary-foreground border-primary"
                : "hover:bg-muted")
            }
          >
            {l.english} · {l.native}
          </Link>
        ))}
      </nav>

      <TranslationWorkbench
        key={language}
        restaurantId={restaurant.id}
        language={language}
        rows={rows}
      />
    </div>
  );
}
