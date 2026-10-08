"use client";

import { useState, useTransition } from "react";
import { Sparkles, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearNutrition,
  confirmNutrition,
  estimateMissingNutrition,
  saveNutrition,
} from "@/lib/nutrition/actions";
import {
  nutritionMismatch,
  parseNutrition,
  type Nutrition,
} from "@/lib/nutrition/core";
import type { NutritionReviewRow } from "@/lib/nutrition/queries";

const STATE_LABEL: Record<NutritionReviewRow["state"], string> = {
  missing: "No nutrition",
  draft: "Draft — not shown yet",
  confirmed: "Shown to diners",
};

type Fields = Record<"calories" | "proteinG" | "carbsG" | "fatG", string>;

function toFields(values: Nutrition | null): Fields {
  return {
    calories: values ? String(values.calories) : "",
    proteinG: values ? String(values.proteinG) : "",
    carbsG: values ? String(values.carbsG) : "",
    fatG: values ? String(values.fatG) : "",
  };
}

const FIELDS: Array<{ key: keyof Fields; label: string; unit: string }> = [
  { key: "calories", label: "Calories", unit: "kcal" },
  { key: "proteinG", label: "Protein", unit: "g" },
  { key: "carbsG", label: "Carbs", unit: "g" },
  { key: "fatG", label: "Fat", unit: "g" },
];

/**
 * The owner's nutrition screen (phase M): every dish, its numbers per
 * serving, and whether diners see them. The AI only estimates; each dish
 * is confirmed on its own, because confirming is the check.
 */
export function NutritionReview({
  restaurantId,
  rows,
}: {
  restaurantId: string;
  rows: NutritionReviewRow[];
}) {
  const [notice, setNotice] = useState<{
    kind: "error" | "info";
    text: string;
  } | null>(null);
  const [estimating, startEstimating] = useTransition();

  const counts = {
    shown: rows.filter((r) => r.state === "confirmed").length,
    toReview: rows.filter((r) => r.state === "draft").length,
    missing: rows.filter((r) => r.state === "missing").length,
  };

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Add dishes to your menu first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
        <p className="text-sm">
          <span className="font-medium">{counts.shown}</span> shown ·{" "}
          <span className="font-medium">{counts.toReview}</span> to review ·{" "}
          <span className="font-medium">{counts.missing}</span> without
          nutrition
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={estimating || counts.missing === 0}
          onClick={() => {
            setNotice(null);
            startEstimating(async () => {
              const result = await estimateMissingNutrition(restaurantId);
              setNotice(
                result.error
                  ? { kind: "error", text: result.error }
                  : { kind: "info", text: result.message ?? "Done." },
              );
            });
          }}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {estimating ? "Estimating…" : "Estimate missing with AI"}
        </Button>
      </div>

      {notice && (
        <Alert variant={notice.kind === "error" ? "destructive" : "default"}>
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}

      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <Row
            // The saved numbers are part of the key, so a row rebuilds with
            // values that arrive from the server (an estimate, a save)
            // instead of keeping the boxes it first rendered.
            key={`${row.itemId}:${row.state}:${row.values ? Object.values(row.values).join(",") : ""}`}
            row={row}
            restaurantId={restaurantId}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({
  row,
  restaurantId,
}: {
  row: NutritionReviewRow;
  restaurantId: string;
}) {
  const saved = toFields(row.values);
  const [fields, setFields] = useState<Fields>(saved);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const edited = (Object.keys(fields) as Array<keyof Fields>).some(
    (k) => fields[k].trim() !== saved[k],
  );

  // The check runs on what's in the boxes, so a typo is caught before it's saved.
  const parsed = parseNutrition(fields);
  const check = parsed.ok ? nutritionMismatch(parsed.value) : null;

  function run(action: () => Promise<{ error?: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
    });
  }

  return (
    <li className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">{row.name}</p>
          {row.category && (
            <p className="text-muted-foreground text-xs">{row.category}</p>
          )}
        </div>
        <span className="flex items-center gap-2">
          {row.source === "ai" && row.state === "draft" && (
            <Badge variant="outline">AI estimate</Badge>
          )}
          <Badge variant={row.state === "confirmed" ? "secondary" : "outline"}>
            {STATE_LABEL[row.state]}
          </Badge>
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 text-xs">
            <span className="text-muted-foreground">
              {f.label} ({f.unit})
            </span>
            <Input
              inputMode="decimal"
              value={fields[f.key]}
              onChange={(e) =>
                setFields((prev) => ({ ...prev, [f.key]: e.target.value }))
              }
              disabled={pending}
              aria-label={`${f.label} for ${row.name}, ${f.unit}`}
            />
          </label>
        ))}
      </div>

      {check?.mismatch && (
        <p className="flex items-start gap-1.5 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          These don&apos;t add up: the protein, carbs and fat come to about{" "}
          {check.expected} kcal. Check for a typo before confirming.
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {(edited || row.state === "missing") && (
          <>
            <Button
              type="button"
              size="sm"
              disabled={pending || !parsed.ok}
              onClick={() =>
                run(() => saveNutrition(restaurantId, row.itemId, fields, true))
              }
            >
              Save and show to diners
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || !parsed.ok}
              onClick={() =>
                run(() =>
                  saveNutrition(restaurantId, row.itemId, fields, false),
                )
              }
            >
              Save draft
            </Button>
          </>
        )}
        {!edited && row.state === "draft" && (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() => confirmNutrition(restaurantId, row.itemId))
            }
          >
            Confirm — show to diners
          </Button>
        )}
        {row.state !== "missing" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => run(() => clearNutrition(restaurantId, row.itemId))}
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}
