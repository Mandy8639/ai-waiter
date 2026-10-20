"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ModelEditor } from "@/components/admin/model-editor";
import type { CatalogueOption } from "@/lib/admin/model-catalogue";
import {
  clearWaiterOverride,
  saveWaiterOverride,
  testWaiterOverride,
  type OverrideTarget,
} from "@/lib/admin/waiter-override-actions";
import {
  waiterSourceLabel,
  type WaiterModelSource,
} from "@/lib/ai/waiter-models-core";

/**
 * Admin Phase 7: one restaurant's or one plan's waiter model, shown with
 * where it comes from, and changed through the same Change → Test → Save
 * editor as the platform list. "Use the default" removes the choice so the
 * next level (plan, then everyone) applies again.
 */
export function WaiterModelLine({
  target,
  name,
  models,
  source,
  own,
  options,
  defaultLabel,
}: {
  target: OverrideTarget;
  /** The restaurant's or plan's name, for the confirm and labels. */
  name: string;
  /** What it uses now. */
  models: string[];
  source: WaiterModelSource;
  /** Its own saved list, if any; null when it follows the next level. */
  own: string[] | null;
  options: CatalogueOption[];
  /** What "Use the default" falls back to, in words. */
  defaultLabel: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const key =
    "restaurantId" in target
      ? `r-${target.restaurantId}`
      : `p-${target.planId}`;

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <p>
        <span className="text-muted-foreground">Waiter model: </span>
        <code className="break-all">{models[0] ?? "none"}</code>
        {models.length > 1 && (
          <span className="text-muted-foreground">
            {" "}
            (+{models.length - 1} backup{models.length > 2 ? "s" : ""})
          </span>
        )}
        <span className="text-muted-foreground">
          {" "}
          · {waiterSourceLabel(source)}
        </span>
      </p>
      <div className="flex flex-wrap items-start gap-2">
        <ModelEditor
          job="waiter"
          label="Diner's AI waiter"
          freeOnly={false}
          current={own ?? models}
          options={options}
          idPrefix={key}
          who={`${name}'s diners`}
          changeLabel="Change waiter model"
          testingNote={
            "restaurantId" in target
              ? `Asking the waiter about ${name}'s own menu. This usually takes a few seconds.`
              : undefined
          }
          testAction={(m) => testWaiterOverride(target, m)}
          saveAction={(m, testId) => saveWaiterOverride(target, m, testId)}
        />
        {own && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => {
              setError(null);
              start(async () => {
                const r = await clearWaiterOverride(target);
                if (!r.ok) setError(r.error);
              });
            }}
          >
            {pending ? "…" : `Use ${defaultLabel}`}
          </Button>
        )}
      </div>
      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}
