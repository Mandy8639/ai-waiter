"use client";

import { useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/dashboard/native-select";
import { saveModelList, testModelList } from "@/lib/admin/actions";
import type { CatalogueOption } from "@/lib/admin/model-catalogue";
import {
  formatCost,
  formatSeconds,
  sameModelList,
  type ModelTestResult,
} from "@/lib/admin/model-test-core";
import type { AiJob } from "@/lib/ai/model-settings-core";

const OTHER = "__other__";
const SLOTS = ["Main model", "Backup 1", "Backup 2"] as const;

interface Slot {
  choice: string;
  other: string;
}

function slotsFrom(models: readonly string[], options: CatalogueOption[]) {
  return SLOTS.map((_, i): Slot => {
    const model = models[i] ?? "";
    if (model === "" || options.some((o) => o.model === model)) {
      return { choice: model, other: "" };
    }
    return { choice: OTHER, other: model };
  });
}

function listFrom(slots: Slot[]): string[] {
  return slots
    .map((s) => (s.choice === OTHER ? s.other : s.choice).trim())
    .filter((m) => m !== "");
}

/**
 * One AI job's Change → Test → Save editor on /admin (docs/admin.md,
 * Phase 2). Save stays disabled until a Test has passed on exactly the
 * list shown; changing any dropdown afterwards disables it again. The
 * server and the database check the same thing, so this is the courtesy
 * layer, not the protection.
 */
export function ModelEditor({
  job,
  label,
  freeOnly,
  current,
  options,
  testAction,
  saveAction,
  who: whoOverride,
  idPrefix,
  testingNote,
  changeLabel = "Change",
}: {
  job: AiJob;
  label: string;
  freeOnly: boolean;
  current: string[];
  options: CatalogueOption[];
  /**
   * Phase 7: Test and Save for one restaurant's or one plan's waiter list,
   * as bound server actions. Without them the editor sets the job's
   * platform-wide list, as before.
   */
  testAction?: (
    models: string[],
  ) => Promise<
    | { error: string }
    | { result: ModelTestResult; testId?: string; error?: string }
  >;
  saveAction?: (
    models: string[],
    testId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Who the confirm says will start using the list. */
  who?: string;
  /** Keeps field ids unique when several editors for one job share a page. */
  idPrefix?: string;
  testingNote?: string;
  changeLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [slots, setSlots] = useState<Slot[]>(() => slotsFrom(current, options));
  const [test, setTest] = useState<{
    result: ModelTestResult;
    testId?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [testing, startTest] = useTransition();
  const [saving, startSave] = useTransition();

  const list = listFrom(slots);
  const passedThisList =
    test?.testId !== undefined && sameModelList(test.result.models, list);
  const unchanged = sameModelList(list, current);

  function reset() {
    setSlots(slotsFrom(current, options));
    setTest(null);
    setError(null);
  }

  function update(index: number, patch: Partial<Slot>) {
    setSlots((s) =>
      s.map((slot, i) => (i === index ? { ...slot, ...patch } : slot)),
    );
  }

  function runTest() {
    setError(null);
    startTest(async () => {
      const outcome = testAction
        ? await testAction(list)
        : await testModelList(job, list);
      if ("result" in outcome) {
        setTest({ result: outcome.result, testId: outcome.testId });
      } else {
        setTest(null);
      }
      setError(outcome.error ?? null);
    });
  }

  function save() {
    if (!test?.testId) return;
    const testId = test.testId;
    startSave(async () => {
      const outcome = saveAction
        ? await saveAction(list, testId)
        : await saveModelList(job, list, testId);
      setConfirming(false);
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      setOpen(false);
      setTest(null);
    });
  }

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {changeLabel}
      </Button>
    );
  }

  const who =
    whoOverride ?? (job === "waiter" ? "Diners" : label.split(" (")[0]);

  return (
    <div className="bg-muted/30 flex flex-col gap-3 rounded-md border p-3">
      {SLOTS.map((slotLabel, i) => {
        const slot = slots[i];
        const option = options.find((o) => o.model === slot.choice);
        const id = `${idPrefix ?? job}-model-${i}`;
        return (
          <div key={slotLabel} className="flex flex-col gap-1">
            <Label htmlFor={id}>{slotLabel}</Label>
            <NativeSelect
              id={id}
              value={slot.choice}
              disabled={testing || saving}
              onChange={(e) => update(i, { choice: e.target.value })}
            >
              <option value="">{i === 0 ? "Choose a model" : "None"}</option>
              {options.map((o) => (
                <option key={o.model} value={o.model} disabled={!o.available}>
                  {o.model}
                  {o.price ? ` (${o.price === "Free" ? "free" : "paid"})` : ""}
                </option>
              ))}
              <option value={OTHER}>Other…</option>
            </NativeSelect>
            {slot.choice === OTHER && (
              <Input
                aria-label={`${slotLabel}: OpenRouter model name`}
                placeholder="provider/model-name"
                value={slot.other}
                disabled={testing || saving}
                onChange={(e) => update(i, { other: e.target.value })}
              />
            )}
            {option && (
              <p className="text-muted-foreground text-xs">
                {option.note}
                {option.price ? ` · ${option.price}` : ""}
              </p>
            )}
            {slot.choice === OTHER && (
              <p className="text-muted-foreground text-xs">
                Not tested here before. The Test below checks it.
                {freeOnly ? " Must end in :free." : ""}
              </p>
            )}
          </div>
        );
      })}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {test && (
        <TestResultView
          result={test.result}
          stale={!sameModelList(test.result.models, list)}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={testing || saving || list.length === 0}
          onClick={runTest}
        >
          {testing ? "Testing…" : "Test"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!passedThisList || unchanged || testing || saving}
          onClick={() => setConfirming(true)}
        >
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={testing || saving}
          onClick={() => setOpen(false)}
        >
          Cancel
        </Button>
      </div>
      {!passedThisList && !unchanged && list.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Save unlocks once a Test passes on exactly this list.
        </p>
      )}
      {testing && (
        <p className="text-muted-foreground text-xs" aria-live="polite">
          {testingNote ??
            (job === "vision"
              ? "Reading the test menu photo. This can take up to two minutes."
              : "Sending a sample request. This usually takes a few seconds.")}
        </p>
      )}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save this list?</AlertDialogTitle>
            <AlertDialogDescription>
              {who} will start using {list[0]} within about a minute
              {list.length > 1
                ? `, with ${list.slice(1).join(" and ")} as backup`
                : ""}
              . Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not yet</AlertDialogCancel>
            <Button type="button" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TestResultView({
  result,
  stale,
}: {
  result: ModelTestResult;
  stale: boolean;
}) {
  return (
    <div
      className="bg-background flex flex-col gap-2 rounded-md border p-3 text-sm"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.passed ? "default" : "destructive"}>
          {result.passed ? "Test passed" : "Test failed"}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {formatSeconds(result.ms)} · {formatCost(result.costUsd)}
          {result.servedModel ? ` · answered by ${result.servedModel}` : ""}
        </span>
      </div>
      {stale && (
        <p className="text-muted-foreground text-xs">
          This result is for a different list. Test again to save.
        </p>
      )}
      {result.error && <p className="text-destructive">{result.error}</p>}
      {result.checks.length > 0 && (
        <ul className="flex flex-col gap-1">
          {result.checks.map((c) => (
            <li key={c.label} className="flex items-start gap-1.5">
              {c.ok ? (
                <Check
                  className="text-primary mt-0.5 size-4 shrink-0"
                  aria-label="Passed"
                />
              ) : (
                <X
                  className="text-destructive mt-0.5 size-4 shrink-0"
                  aria-label="Failed"
                />
              )}
              <span>{c.label}</span>
            </li>
          ))}
        </ul>
      )}
      {result.reply && (
        <pre className="bg-muted/50 max-h-48 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">
          {result.reply}
        </pre>
      )}
    </div>
  );
}
