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
import { Switch } from "@/components/ui/switch";
import {
  checkSafetyNetNow,
  setSafetyNetEnabled,
} from "@/lib/admin/safety-net-actions";

export interface SafetyNetRow {
  model: string;
  /** Rank in the net (1 = tried first), or null when not in it. */
  rank: number | null;
  status: "passed" | "failed" | "busy";
  /** Already worded on the server, e.g. "passed 3 h ago · 6.2 s". */
  detail: string;
}

/**
 * The Admin page's "Free safety net" card (docs/admin.md): which free
 * models the waiter falls back to when its own list is busy, the on/off
 * switch, and "Check now" for the daily check.
 */
export function SafetyNetCard({
  enabled,
  rows,
  lastChecked,
  canCheck,
}: {
  enabled: boolean;
  rows: SafetyNetRow[];
  /** "3 h ago", or null when no check has run yet. */
  lastChecked: string | null;
  canCheck: boolean;
}) {
  const [on, setOn] = useState(enabled);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, startSwitch] = useTransition();
  const [checking, startCheck] = useTransition();

  const inNet = rows.filter((r) => r.rank !== null);
  const others = rows.filter((r) => r.rank === null);

  function toggle(next: boolean) {
    setError(null);
    setOn(next);
    startSwitch(async () => {
      const result = await setSafetyNetEnabled(next);
      if (!result.ok) {
        setOn(!next);
        setError(result.error);
      }
    });
  }

  function check() {
    setError(null);
    setMessage(null);
    startCheck(async () => {
      const result = await checkSafetyNetNow();
      if ("checked" in result && !result.error) {
        setMessage(
          `Checked ${result.checked} free models: ${result.passed} passed, ${result.failed} failed, ${result.busy} busy.`,
        );
      } else {
        setError(result.error ?? "The check failed.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Free safety net</CardTitle>
        <CardDescription>
          When every model in the waiter&apos;s list is busy, it tries these
          free models instead of telling the diner it can&apos;t answer. Each
          one passed the waiter Test in the last three days. They&apos;re
          checked again every day, at no cost.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3 rounded-md border p-3">
          <span className="text-sm font-medium">
            Use the safety net for the waiter
          </span>
          <Switch
            checked={on}
            disabled={switching}
            onCheckedChange={(checked) => toggle(checked)}
            aria-label="Use the safety net for the waiter"
          />
        </label>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {message && (
          <p className="text-sm" aria-live="polite">
            {message}
          </p>
        )}

        {inNet.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {lastChecked
              ? "No free model passed the waiter Test in the last three days, so there's no safety net right now."
              : "No check has run yet. Press Check now, or wait for the daily check."}
          </p>
        ) : (
          <ol className="flex flex-col gap-1 text-sm">
            {inNet.map((r) => (
              <li key={r.model} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground w-6 shrink-0 text-xs">
                  {r.rank}.
                </span>
                <code className="text-xs break-all">{r.model}</code>
                <span className="text-muted-foreground text-xs">
                  {r.detail}
                </span>
              </li>
            ))}
          </ol>
        )}

        {others.length > 0 && (
          <details className="text-sm">
            <summary className="text-muted-foreground cursor-pointer">
              {others.length} other free model{others.length === 1 ? "" : "s"}{" "}
              checked, not in the net
            </summary>
            <ul className="mt-2 flex flex-col gap-1">
              {others.map((r) => (
                <li key={r.model} className="flex flex-wrap items-center gap-2">
                  <code className="text-xs break-all">{r.model}</code>
                  <Badge
                    variant={r.status === "busy" ? "secondary" : "outline"}
                  >
                    {r.status === "busy" ? "Busy" : "Failed"}
                  </Badge>
                  <span className="text-muted-foreground text-xs">
                    {r.detail}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={checking || !canCheck}
            onClick={check}
          >
            {checking ? "Checking…" : "Check now"}
          </Button>
          <span className="text-muted-foreground text-xs" aria-live="polite">
            {checking
              ? "Testing each free model. This takes up to three minutes."
              : lastChecked
                ? `Last checked ${lastChecked}.`
                : "Never checked."}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
