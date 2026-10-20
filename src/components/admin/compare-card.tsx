"use client";

import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/dashboard/native-select";
import { compareModels } from "@/lib/admin/actions";
import {
  COMPARE_QUESTIONS,
  compareNotes,
  MAX_COMPARE_QUESTION,
  type CompareAnswer,
} from "@/lib/admin/compare-core";
import type { CatalogueOption } from "@/lib/admin/model-catalogue";
import { formatCost, formatSeconds } from "@/lib/admin/model-test-core";

const OTHER = "__other__";

/**
 * The Admin page's side-by-side test (docs/admin.md, Phase 5): two waiter
 * models, one diner question, both answers next to each other. Changes
 * nothing; saving a model is still Change → Test → Save above.
 */
export function CompareCard({
  options,
  current,
}: {
  options: CatalogueOption[];
  /** The waiter's main model now, preselected on the left. */
  current: string | null;
}) {
  const available = options.filter((o) => o.available).map((o) => o.model);
  const first = current && available.includes(current) ? current : "";
  const [choices, setChoices] = useState<string[]>([
    first,
    available.find((m) => m !== first) ?? "",
  ]);
  const [others, setOthers] = useState(["", ""]);
  const [question, setQuestion] = useState<string>(COMPARE_QUESTIONS[0]);
  const [answers, setAnswers] = useState<[CompareAnswer, CompareAnswer] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [running, start] = useTransition();

  const models = choices.map((c, i) => (c === OTHER ? others[i] : c).trim());

  function run() {
    setError(null);
    start(async () => {
      const outcome = await compareModels(models, question);
      if ("error" in outcome) {
        setError(outcome.error);
        return;
      }
      setAnswers(outcome.answers);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Side-by-side test</CardTitle>
        <CardDescription>
          Ask two waiter models the same diner question on the sample menu and
          read their answers next to each other. Nothing is saved or changed; a
          paid model spends a little credit.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="flex flex-col gap-1">
              <Label htmlFor={`compare-model-${i}`}>
                {i === 0 ? "Model A" : "Model B"}
              </Label>
              <NativeSelect
                id={`compare-model-${i}`}
                value={choices[i]}
                disabled={running}
                onChange={(e) =>
                  setChoices((c) =>
                    c.map((v, j) => (j === i ? e.target.value : v)),
                  )
                }
              >
                <option value="">Choose a model</option>
                {options.map((o) => (
                  <option key={o.model} value={o.model} disabled={!o.available}>
                    {o.model}
                    {o.price
                      ? ` (${o.price === "Free" ? "free" : "paid"})`
                      : ""}
                  </option>
                ))}
                <option value={OTHER}>Other…</option>
              </NativeSelect>
              {choices[i] === OTHER && (
                <Input
                  aria-label={`Model ${i === 0 ? "A" : "B"}: OpenRouter model name`}
                  placeholder="provider/model-name"
                  value={others[i]}
                  disabled={running}
                  onChange={(e) =>
                    setOthers((o) =>
                      o.map((v, j) => (j === i ? e.target.value : v)),
                    )
                  }
                />
              )}
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="compare-question">Diner&apos;s question</Label>
          <Input
            id="compare-question"
            value={question}
            maxLength={MAX_COMPARE_QUESTION}
            disabled={running}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {COMPARE_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                disabled={running}
                onClick={() => setQuestion(q)}
                className="text-muted-foreground hover:bg-muted rounded-full border px-2.5 py-0.5 text-xs"
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        <Button
          type="button"
          size="sm"
          className="self-start"
          disabled={running || models.some((m) => m === "")}
          onClick={run}
        >
          {running ? "Asking both…" : "Compare"}
        </Button>
        {running && (
          <p className="text-muted-foreground text-xs" aria-live="polite">
            Both models are answering at once. This usually takes a few seconds.
          </p>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {answers && (
          <div className="flex flex-col gap-3" aria-live="polite">
            <div className="grid gap-3 sm:grid-cols-2">
              {answers.map((a, i) => (
                <AnswerView key={i} label={i === 0 ? "A" : "B"} answer={a} />
              ))}
            </div>
            {compareNotes(answers[0], answers[1]).length > 0 && (
              <ul className="text-muted-foreground list-disc pl-5 text-sm">
                {compareNotes(answers[0], answers[1]).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AnswerView({
  label,
  answer,
}: {
  label: string;
  answer: CompareAnswer;
}) {
  return (
    <div className="bg-background flex flex-col gap-2 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{label}</Badge>
        <code className="text-xs break-all">{answer.model}</code>
      </div>
      <p className="text-muted-foreground text-xs">
        {formatSeconds(answer.ms)} · {formatCost(answer.costUsd)}
        {answer.tools.length > 0
          ? ` · looked up: ${answer.tools.join(", ")}`
          : " · didn't use the menu tools"}
      </p>
      {answer.error ? (
        <p className="text-destructive">
          {answer.busy
            ? "This model was busy (rate limited). Try again in a minute."
            : answer.error}
        </p>
      ) : (
        <p className="whitespace-pre-wrap">{answer.reply || "(no answer)"}</p>
      )}
    </div>
  );
}
