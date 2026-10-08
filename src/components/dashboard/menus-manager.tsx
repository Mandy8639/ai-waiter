"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createMenu,
  deleteMenu,
  renameMenu,
  setMenuHours,
  setMenuPublished,
  setMenuSection,
} from "@/lib/menus/actions";
import {
  hoursLabel,
  rowsFromRules,
  rulesFromHours,
  type HoursRule,
  type MenuHoursWindow,
} from "@/lib/menus/core";
import { cn } from "@/lib/utils";

export interface ManagedMenu {
  id: string;
  name: string;
  isDefault: boolean;
  isPublished: boolean;
  onNow: boolean;
  hours: MenuHoursWindow[];
  categoryIds: string[];
}

interface Section {
  id: string;
  name: string;
  isActive: boolean;
}

// Monday first, as a week reads.
const DAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

/**
 * The owner's menus screen (phase L): each menu's name, whether it's live,
 * its hours and its sections, plus any section that's on no menu at all
 * (and so hidden from diners).
 */
export function MenusManager({
  restaurantId,
  menus,
  categories,
}: {
  restaurantId: string;
  menus: ManagedMenu[];
  categories: Section[];
}) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const onSomeMenu = new Set(menus.flatMap((m) => m.categoryIds));
  const orphans = categories.filter((c) => !onSomeMenu.has(c.id));

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {orphans.length > 0 && (
        <Alert>
          <AlertDescription>
            {orphans.map((c) => c.name).join(", ")}{" "}
            {orphans.length === 1 ? "is" : "are"} on no menu, so diners
            can&apos;t see or order {orphans.length === 1 ? "it" : "them"}.
          </AlertDescription>
        </Alert>
      )}

      <ul className="flex flex-col gap-4">
        {menus.map((menu) => (
          <MenuCard
            key={`${menu.id}:${JSON.stringify(menu.hours)}`}
            menu={menu}
            restaurantId={restaurantId}
            categories={categories}
          />
        ))}
      </ul>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const result = await createMenu(restaurantId, newName);
            if (result.error) setError(result.error);
            else setNewName("");
          });
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New menu, e.g. Lunch or Dinner"
          maxLength={40}
          aria-label="New menu name"
        />
        <Button type="submit" disabled={pending || !newName.trim()}>
          <Plus className="size-4" aria-hidden="true" />
          Add menu
        </Button>
      </form>
      <p className="text-muted-foreground -mt-4 text-xs">
        New menus start as drafts. Diners don&apos;t see a menu until you
        publish it.
      </p>
    </div>
  );
}

function MenuCard({
  menu,
  restaurantId,
  categories,
}: {
  menu: ManagedMenu;
  restaurantId: string;
  categories: Section[];
}) {
  const [name, setName] = useState(menu.name);
  const [rules, setRules] = useState<HoursRule[]>(rulesFromHours(menu.hours));
  const [hoursDirty, setHoursDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();

  function run(action: () => Promise<{ error?: string }>, after?: () => void) {
    setError(null);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else after?.();
    });
  }

  function updateRule(index: number, patch: Partial<HoursRule>) {
    setRules((prev) =>
      prev.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    );
    setHoursDirty(true);
  }

  const preview = rowsFromRules(rules);

  return (
    <li className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40}
          aria-label={`Name of the ${menu.name} menu`}
          className="max-w-56 font-medium"
        />
        {name.trim() !== menu.name && (
          <Button
            type="button"
            size="sm"
            disabled={pending || !name.trim()}
            onClick={() => run(() => renameMenu(restaurantId, menu.id, name))}
          >
            Save name
          </Button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {menu.isDefault && <Badge variant="outline">Default</Badge>}
          {!menu.isPublished ? (
            <Badge variant="outline">Draft</Badge>
          ) : menu.onNow ? (
            <Badge variant="secondary">On now</Badge>
          ) : (
            <Badge variant="outline">Off now</Badge>
          )}
        </span>
      </div>

      {menu.isDefault && (
        <p className="text-muted-foreground -mt-2 text-xs">
          New sections are added here automatically. The default menu is always
          published and can&apos;t be deleted.
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Hours</h3>
        {rules.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No hours set: this menu is on whenever it&apos;s published.
          </p>
        )}
        {rules.map((rule, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <div
              className="flex flex-wrap gap-1"
              role="group"
              aria-label="Days"
            >
              {DAYS.map((d) => {
                const on = rule.days.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      updateRule(i, {
                        days: on
                          ? rule.days.filter((x) => x !== d.value)
                          : [...rule.days, d.value],
                      })
                    }
                    className={cn(
                      "rounded-md border px-2 py-1 text-xs",
                      on
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-muted",
                    )}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
            <Input
              type="time"
              value={rule.opens}
              onChange={(e) => updateRule(i, { opens: e.target.value })}
              aria-label="Opens"
              className="w-28"
            />
            <span className="text-muted-foreground text-sm">to</span>
            <Input
              type="time"
              value={rule.closes === "24:00" ? "23:59" : rule.closes}
              onChange={(e) =>
                updateRule(i, {
                  closes: e.target.value === "23:59" ? "24:00" : e.target.value,
                })
              }
              aria-label="Closes"
              className="w-28"
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label="Remove these hours"
              onClick={() => {
                setRules((prev) => prev.filter((_, j) => j !== i));
                setHoursDirty(true);
              }}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setRules((prev) => [
                ...prev,
                { days: [1, 2, 3, 4, 5], opens: "11:00", closes: "15:00" },
              ]);
              setHoursDirty(true);
            }}
          >
            Add hours
          </Button>
          {hoursDirty && (
            <Button
              type="button"
              size="sm"
              disabled={pending || !preview.ok}
              onClick={() =>
                run(
                  () => setMenuHours(restaurantId, menu.id, rules),
                  () => setHoursDirty(false),
                )
              }
            >
              Save hours
            </Button>
          )}
          <span className="text-muted-foreground text-xs">
            {preview.ok ? hoursLabel(preview.rows) : preview.error}
          </span>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Sections on this menu</h3>
        {categories.length === 0 ? (
          <p className="text-muted-foreground text-sm">No sections yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => {
              const on = menu.categoryIds.includes(c.id);
              return (
                <label
                  key={c.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                    on && "border-primary bg-primary/5",
                    !c.isActive && "opacity-60",
                  )}
                >
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={on}
                    disabled={pending}
                    onChange={() =>
                      run(() =>
                        setMenuSection(restaurantId, menu.id, c.id, !on),
                      )
                    }
                  />
                  {c.name}
                  {!c.isActive && (
                    <span className="text-muted-foreground text-xs">
                      (hidden)
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </section>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex flex-wrap gap-2 border-t pt-3">
        {!menu.isDefault && (
          <Button
            type="button"
            size="sm"
            variant={menu.isPublished ? "outline" : "default"}
            disabled={pending}
            onClick={() =>
              run(() =>
                setMenuPublished(restaurantId, menu.id, !menu.isPublished),
              )
            }
          >
            {menu.isPublished ? "Unpublish (back to draft)" : "Publish"}
          </Button>
        )}
        {!menu.isDefault &&
          (confirmDelete ? (
            <>
              <span className="text-muted-foreground self-center text-sm">
                Delete {menu.name}? Its sections stay on other menus.
              </span>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => run(() => deleteMenu(restaurantId, menu.id))}
              >
                Delete
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Keep
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
            >
              Delete menu
            </Button>
          ))}
      </div>
    </li>
  );
}
