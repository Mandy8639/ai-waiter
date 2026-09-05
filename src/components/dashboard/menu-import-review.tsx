"use client";

import { useActionState, useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  commitImport,
  saveImportReview,
  type MenuImportState,
} from "@/lib/menu-import/actions";

export interface ReviewRow {
  id: string;
  categoryName: string;
  name: string;
  price: number | null;
  include: boolean;
}

/**
 * The review step, which is the point of the whole feature.
 *
 * Extraction is good but not authoritative: a menu is the price list a
 * customer is charged from, and this project already has an incident of a
 * model confidently reporting something it never did. So every row is
 * editable, and rows the reader could not price are surfaced FIRST and
 * block the commit until resolved — the database refuses them anyway
 * (commit_menu_import raises MENU_IMPORT_UNPRICED_ITEMS), but being told
 * up front beats being rejected at the end.
 */
export function MenuImportReview({
  restaurantId,
  importId,
  initialRows,
}: {
  restaurantId: string;
  importId: string;
  initialRows: ReviewRow[];
}) {
  const [rows, setRows] = useState<ReviewRow[]>(initialRows);
  const [saving, startSaving] = useTransition();
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const [commitState, commitAction, committing] = useActionState<
    MenuImportState,
    FormData
  >(commitImport.bind(null, restaurantId), {});

  const included = rows.filter((r) => r.include);
  const blocking = included.filter((r) => r.price === null);

  const categories = useMemo(
    () => [...new Set(rows.map((r) => r.categoryName))],
    [rows],
  );

  function update(id: string, patch: Partial<ReviewRow>) {
    setRows((current) =>
      current.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
    setSavedNote(null);
  }

  function save() {
    startSaving(async () => {
      const result = await saveImportReview(
        restaurantId,
        importId,
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          price: r.price,
          include: r.include,
        })),
      );
      setSavedNote(result.error ?? result.notice ?? null);
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span>
          <strong>{included.length}</strong> of {rows.length} items selected
        </span>
        <span className="text-muted-foreground">
          {categories.length} categories
        </span>
      </div>

      {blocking.length > 0 && (
        <Alert>
          <AlertDescription>
            <strong>
              {blocking.length} item{blocking.length === 1 ? "" : "s"} had no
              price on the menu.
            </strong>{" "}
            Add a price, or untick the item, before adding these to your menu.
            Nothing is imported at £0.
          </AlertDescription>
        </Alert>
      )}

      {commitState.error && (
        <Alert variant="destructive">
          <AlertDescription>{commitState.error}</AlertDescription>
        </Alert>
      )}
      {savedNote && (
        <Alert>
          <AlertDescription>{savedNote}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-4">
        {categories.map((category) => (
          <section key={category} className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold tracking-tight">{category}</h2>
            <ul className="flex flex-col gap-1">
              {rows
                .filter((r) => r.categoryName === category)
                .map((row) => (
                  <li
                    key={row.id}
                    className="flex items-center gap-2 rounded-md border px-3 py-2"
                  >
                    <input
                      type="checkbox"
                      checked={row.include}
                      onChange={(e) =>
                        update(row.id, { include: e.target.checked })
                      }
                      aria-label={`Include ${row.name}`}
                      className="accent-primary size-4 shrink-0"
                    />
                    <Input
                      value={row.name}
                      onChange={(e) => update(row.id, { name: e.target.value })}
                      aria-label={`Name of ${row.name}`}
                      className="flex-1"
                    />
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={row.price ?? ""}
                      placeholder="No price"
                      onChange={(e) =>
                        update(row.id, {
                          price:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                      aria-label={`Price of ${row.name}`}
                      aria-invalid={row.include && row.price === null}
                      className="w-28 shrink-0"
                    />
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={save}
          disabled={saving || committing}
        >
          {saving ? "Saving…" : "Save changes"}
        </Button>

        <form action={commitAction}>
          <input type="hidden" name="importId" value={importId} />
          <Button
            type="submit"
            disabled={
              committing ||
              saving ||
              included.length === 0 ||
              blocking.length > 0
            }
          >
            {committing
              ? "Adding to menu…"
              : `Add ${included.length} items to menu`}
          </Button>
        </form>

        {blocking.length > 0 && (
          <p className="text-muted-foreground text-sm">
            Resolve the items without a price first.
          </p>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        Save your changes before adding to the menu — the import is committed
        from what&apos;s saved here.
      </p>
    </div>
  );
}
