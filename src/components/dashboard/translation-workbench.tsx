"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  approveTranslation,
  deleteTranslation,
  draftMissingTranslations,
  saveTranslation,
} from "@/lib/translations/actions";
import type { WorkbenchRow } from "@/lib/translations/queries";
import { languageInfo, type MenuLanguage } from "@/lib/translations/languages";

const STATE_LABEL: Record<WorkbenchRow["state"], string> = {
  missing: "Not translated",
  draft: "Draft — not shown yet",
  approved: "Shown to diners",
  stale: "Original changed — not shown",
};

/**
 * The owner's translation screen (phase K): every dish name, description
 * and category, with its translation beside the original. Drafting fills
 * in drafts; each one is approved on its own, because approving is the
 * review.
 */
export function TranslationWorkbench({
  restaurantId,
  language,
  rows,
}: {
  restaurantId: string;
  language: MenuLanguage;
  rows: WorkbenchRow[];
}) {
  const [notice, setNotice] = useState<{
    kind: "error" | "info";
    text: string;
  } | null>(null);
  const [drafting, startDrafting] = useTransition();
  const info = languageInfo(language);

  const counts = {
    shown: rows.filter((r) => r.state === "approved").length,
    toReview: rows.filter((r) => r.state === "draft" || r.state === "stale")
      .length,
    missing: rows.filter((r) => r.state === "missing").length,
    // What "Draft with AI" will actually touch: never a person's current draft.
    toDraft: rows.filter((r) => r.state === "missing" || r.state === "stale")
      .length,
  };

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Add dishes to your menu first; there&apos;s nothing to translate yet.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
        <p className="text-sm">
          <span className="font-medium">{counts.shown}</span> shown ·{" "}
          <span className="font-medium">{counts.toReview}</span> to review ·{" "}
          <span className="font-medium">{counts.missing}</span> not translated
        </p>
        <Button
          type="button"
          disabled={drafting || counts.toDraft === 0}
          onClick={() => {
            setNotice(null);
            startDrafting(async () => {
              const result = await draftMissingTranslations(
                restaurantId,
                language,
              );
              setNotice(
                result.error
                  ? { kind: "error", text: result.error }
                  : { kind: "info", text: result.message ?? "Done." },
              );
            });
          }}
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {drafting ? "Drafting…" : `Draft missing ${info.english} with AI`}
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
            // The saved text is part of the key, so a row rebuilds with a
            // draft that arrives from the server (AI drafting, a save)
            // instead of keeping the empty box it first rendered.
            key={`${row.entity}:${row.entityId}:${row.field}:${row.translationId ?? ""}:${row.text ?? ""}`}
            row={row}
            restaurantId={restaurantId}
            language={language}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({
  row,
  restaurantId,
  language,
}: {
  row: WorkbenchRow;
  restaurantId: string;
  language: MenuLanguage;
}) {
  const [text, setText] = useState(row.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const edited = text.trim() !== (row.text ?? "").trim();

  function run(action: () => Promise<{ error?: string }>) {
    setError(null);
    start(async () => {
      const result = await action();
      if (result.error) setError(result.error);
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-xs font-medium uppercase">
          {row.context}
        </span>
        <span className="flex items-center gap-2">
          {row.origin === "ai" && row.state !== "approved" && (
            <Badge variant="outline">AI draft</Badge>
          )}
          <Badge
            variant={
              row.state === "approved"
                ? "secondary"
                : row.state === "stale"
                  ? "destructive"
                  : "outline"
            }
          >
            {STATE_LABEL[row.state]}
          </Badge>
        </span>
      </div>
      <p className="text-sm">{row.source}</p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={row.field === "description" ? 3 : 1}
        maxLength={1000}
        lang={language}
        aria-label={`Translation of ${row.context}`}
        disabled={pending}
      />
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {edited && text.trim() !== "" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(() =>
                saveTranslation(restaurantId, {
                  entity: row.entity,
                  entityId: row.entityId,
                  field: row.field,
                  language,
                  text,
                }),
              )
            }
          >
            Save draft
          </Button>
        )}
        {row.translationId &&
          !edited &&
          (row.state === "draft" || row.state === "stale") && (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(() => approveTranslation(restaurantId, row.translationId!))
              }
            >
              {row.state === "stale"
                ? "Approve for the new original"
                : "Approve — show to diners"}
            </Button>
          )}
        {row.translationId && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(() => deleteTranslation(restaurantId, row.translationId!))
            }
          >
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}
