import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import {
  MenusManager,
  type ManagedMenu,
} from "@/components/dashboard/menus-manager";
import { createClient } from "@/lib/supabase/server";
import { requireCurrentRestaurant } from "@/lib/restaurants/require-current-restaurant";
import { SpecialHoursCard } from "@/components/dashboard/special-hours-card";
import {
  todayIn,
  type MenuHoursWindow,
  type SpecialHours,
} from "@/lib/menus/core";

export const metadata = {
  title: "Menus — Tableside",
};

/**
 * Phase L: a restaurant's menus — Lunch, Dinner, Drinks — with their
 * hours and sections. Owners and managers only; RLS enforces it too.
 */
export default async function MenusPage() {
  const { restaurant } = await requireCurrentRestaurant();
  if (restaurant.role !== "owner" && restaurant.role !== "manager") {
    notFound();
  }

  const supabase = await createClient();
  // database.types.ts predates 20261004090000.
  const untyped = supabase as unknown as {
    from: (table: string) => {
      select: (columns: string) => {
        eq: (
          c: string,
          v: string,
        ) => Promise<{ data: unknown[] | null }> & {
          gte: (
            c: string,
            v: string,
          ) => {
            order: (
              c: string,
              o: { ascending: boolean },
            ) => Promise<{ data: unknown[] | null }>;
          };
        };
      };
    };
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown }>;
  };

  const today = todayIn(restaurant.timezone);
  const [menusRes, hoursRes, sectionsRes, { data: categories }, specialRes] =
    await Promise.all([
      untyped
        .from("menus")
        .select("id, name, is_default, is_published, sort_order")
        .eq("restaurant_id", restaurant.id),
      untyped
        .from("menu_hours")
        .select("menu_id, day_of_week, opens_at, closes_at")
        .eq("restaurant_id", restaurant.id),
      untyped
        .from("menu_sections")
        .select("menu_id, category_id")
        .eq("restaurant_id", restaurant.id),
      supabase
        .from("categories")
        .select("id, name, is_active, display_order")
        .eq("restaurant_id", restaurant.id)
        .order("display_order", { ascending: true }),
      untyped
        .from("restaurant_special_hours")
        .select("id, day, closed, opens_at, closes_at, note")
        .eq("restaurant_id", restaurant.id)
        .gte("day", today)
        .order("day", { ascending: true }),
    ]);

  // Which menus are on right now, decided by the database in the
  // restaurant's timezone (drafts are never on).
  const onNowIds = new Set<string>();
  for (const m of (menusRes.data ?? []) as Array<{ id: string }>) {
    const { data } = await untyped.rpc("menu_on_now", { p_menu_id: m.id });
    if (data === true) onNowIds.add(m.id);
  }

  const toTime = (t: string) => t.slice(0, 5);
  const hours = (hoursRes.data ?? []) as Array<{
    menu_id: string;
    day_of_week: number;
    opens_at: string;
    closes_at: string;
  }>;
  const sections = (sectionsRes.data ?? []) as Array<{
    menu_id: string;
    category_id: string;
  }>;

  const upcoming: SpecialHours[] = (
    (specialRes.data ?? []) as Array<{
      id: string;
      day: string;
      closed: boolean;
      opens_at: string | null;
      closes_at: string | null;
      note: string | null;
    }>
  ).map((r) => ({
    id: r.id,
    day: r.day,
    closed: r.closed,
    opens: r.opens_at && toTime(r.opens_at),
    closes: r.closes_at && toTime(r.closes_at),
    note: r.note,
  }));

  const menus: ManagedMenu[] = (
    (menusRes.data ?? []) as Array<{
      id: string;
      name: string;
      is_default: boolean;
      is_published: boolean;
      sort_order: number;
    }>
  )
    .sort(
      (a, b) =>
        Number(b.is_default) - Number(a.is_default) ||
        a.sort_order - b.sort_order ||
        a.name.localeCompare(b.name),
    )
    .map((m) => ({
      id: m.id,
      name: m.name,
      isDefault: m.is_default,
      isPublished: m.is_published,
      onNow: onNowIds.has(m.id),
      hours: hours
        .filter((h) => h.menu_id === m.id)
        .map((h): MenuHoursWindow => ({
          day: h.day_of_week,
          opens: toTime(h.opens_at),
          closes: toTime(h.closes_at),
        })),
      categoryIds: sections
        .filter((s) => s.menu_id === m.id)
        .map((s) => s.category_id),
    }));

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
        <h1 className="text-2xl font-semibold tracking-tight">Menus</h1>
        <p className="text-muted-foreground text-sm">
          Run a lunch menu and a dinner menu with their own hours. Diners only
          see — and can only order — what&apos;s on a menu that&apos;s on right
          now. Times are in {restaurant.timezone}.
        </p>
      </div>
      <MenusManager
        restaurantId={restaurant.id}
        menus={menus}
        categories={(categories ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          isActive: c.is_active,
        }))}
      />
      <SpecialHoursCard
        restaurantId={restaurant.id}
        upcoming={upcoming}
        today={today}
      />
    </div>
  );
}
