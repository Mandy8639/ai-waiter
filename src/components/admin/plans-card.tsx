"use client";

import { useState, useTransition } from "react";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatFeeBps, formatMonthlyPrice } from "@/lib/billing/format";
import {
  changeFreeMonth,
  changePlanFee,
  changePlanPrice,
} from "@/lib/admin/plan-actions";
import {
  FREE_MONTH_DAYS_MAX,
  parseDollars,
  parsePercent,
  validFreeMonthDays,
} from "@/lib/admin/plan-admin-core";
import type { PlansAdminData } from "@/lib/admin/plan-queries";

type Editing =
  | { kind: "price" | "fee"; planId: string; value: string }
  | { kind: "free_month"; value: string };

/**
 * Admin Phase 8 (docs/admin.md): plan prices, card fees and the free
 * month. Every change is confirmed with what it will do to whom, and
 * recorded. Prices go through Stripe and are locked on live Stripe until
 * the owner sets ADMIN_LIVE_PRICE_CHANGES=1.
 */
export function PlansCard({ data }: { data: PlansAdminData }) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, start] = useTransition();

  const plan =
    editing && editing.kind !== "free_month"
      ? data.plans.find((p) => p.id === editing.planId)
      : undefined;

  const parsed =
    editing?.kind === "price"
      ? parseDollars(editing.value)
      : editing?.kind === "fee"
        ? parsePercent(editing.value)
        : editing?.kind === "free_month"
          ? validFreeMonthDays(Number(editing.value)) &&
            editing.value.trim() !== ""
            ? Number(editing.value)
            : null
          : null;

  const priceLocked =
    data.stripeMode === "none" ||
    data.stripeMode === "unknown" ||
    (data.stripeMode === "live" && !data.liveApproved);

  function summary(): string {
    if (!editing || parsed === null) return "";
    if (editing.kind === "free_month") {
      return `Restaurants that sign up from now get ${parsed} ${parsed === 1 ? "day" : "days"} with no platform fee and no subscription needed. Restaurants already in their free month keep the end date they have.`;
    }
    if (!plan) return "";
    if (editing.kind === "price") {
      return `${plan.name} goes from ${formatMonthlyPrice(plan.monthlyPriceCents, plan.currency)} to ${formatMonthlyPrice(parsed, plan.currency)} a month. ${parsed > 0 ? `A new price is created in Stripe (${data.stripeMode} mode). ` : ""}New subscribers pay the new price; the ${plan.subscribers} current ${plan.subscribers === 1 ? "subscriber keeps" : "subscribers keep"} the price they signed up to.`;
    }
    return `${plan.name}'s card fee goes from ${formatFeeBps(plan.feeBps)} to ${formatFeeBps(parsed)}. Every restaurant on ${plan.name} pays it from its next card payment, including current subscribers.`;
  }

  function save() {
    if (!editing || parsed === null) return;
    const e = editing;
    const value = parsed;
    start(async () => {
      const result =
        e.kind === "free_month"
          ? await changeFreeMonth(value)
          : e.kind === "price"
            ? await changePlanPrice(e.planId, value)
            : await changePlanFee(e.planId, value);
      setConfirming(false);
      setNotice(
        result.ok
          ? { ok: true, text: result.message }
          : { ok: false, text: result.error },
      );
      if (result.ok) setEditing(null);
    });
  }

  function editor(label: string, placeholder: string) {
    if (!editing) return null;
    return (
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (parsed !== null) setConfirming(true);
        }}
      >
        <Input
          autoFocus
          aria-label={label}
          placeholder={placeholder}
          value={editing.value}
          onChange={(ev) => setEditing({ ...editing, value: ev.target.value })}
          className="w-36"
        />
        <Button type="submit" size="sm" disabled={parsed === null || pending}>
          Review change
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setEditing(null)}
        >
          Cancel
        </Button>
        {editing.value.trim() !== "" && parsed === null && (
          <span className="text-destructive text-xs">
            {editing.kind === "price"
              ? "A price like 19 or 19.99, up to $1,000."
              : editing.kind === "fee"
                ? "A percent like 1 or 0.5, up to 10%."
                : `Whole days, 0 to ${FREE_MONTH_DAYS_MAX}.`}
          </span>
        )}
      </form>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          Plans and pricing
          <Badge variant={data.stripeMode === "live" ? "default" : "outline"}>
            {data.stripeMode === "none"
              ? "Stripe not set up"
              : data.stripeMode === "live"
                ? data.liveApproved
                  ? "Live Stripe · price changes on"
                  : "Live Stripe · price changes locked"
                : data.stripeMode === "test"
                  ? "Stripe test mode"
                  : "Stripe key not recognised"}
          </Badge>
        </CardTitle>
        <CardDescription>
          Change what restaurants pay. A new monthly price applies to new
          subscribers (Stripe keeps current ones on their price); a new card fee
          applies to everyone on the plan; a new free month applies to new
          restaurants. Each change is confirmed first and recorded below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {notice && (
          <Alert variant={notice.ok ? "default" : "destructive"}>
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )}
        {data.stripeMode === "live" && !data.liveApproved && (
          <p className="text-muted-foreground rounded-md border p-3 text-xs">
            Monthly prices can&apos;t be changed on live Stripe yet. Try a
            change in Stripe test mode first; to unlock live, set{" "}
            <code>ADMIN_LIVE_PRICE_CHANGES=1</code> in Vercel. Card fees and the
            free month don&apos;t touch Stripe and can be changed now.
          </p>
        )}

        <ul className="flex flex-col gap-2">
          {data.plans.map((p) => (
            <li
              key={p.id}
              className="flex flex-col gap-2 rounded-lg border p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {p.name}
                  {p.isDefault && (
                    <span className="text-muted-foreground text-xs font-normal">
                      {" "}
                      · new restaurants start here
                    </span>
                  )}
                </span>
                <span className="text-muted-foreground text-xs">
                  {p.subscribers} paying{" "}
                  {p.subscribers === 1 ? "subscriber" : "subscribers"}
                </span>
              </div>
              <p className="text-sm">
                {formatMonthlyPrice(p.monthlyPriceCents, p.currency)}
                {p.monthlyPriceCents > 0 ? "/month" : ""} +{" "}
                {formatFeeBps(p.feeBps)} of card payments
              </p>
              {editing &&
              editing.kind !== "free_month" &&
              editing.planId === p.id ? (
                editor(
                  editing.kind === "price"
                    ? `${p.name} monthly price in dollars`
                    : `${p.name} card fee in percent`,
                  editing.kind === "price" ? "e.g. 19" : "e.g. 1",
                )
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={priceLocked || pending}
                    title={
                      priceLocked ? "Locked: see the note above." : undefined
                    }
                    onClick={() =>
                      setEditing({
                        kind: "price",
                        planId: p.id,
                        value: (p.monthlyPriceCents / 100).toString(),
                      })
                    }
                  >
                    Change price
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      setEditing({
                        kind: "fee",
                        planId: p.id,
                        value: (p.feeBps / 100).toString(),
                      })
                    }
                  >
                    Change fee
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="flex flex-col gap-2 rounded-lg border p-3">
          <p className="font-medium">Free first month</p>
          <p className="text-sm">
            {data.freeMonthDays} {data.freeMonthDays === 1 ? "day" : "days"}{" "}
            with no platform fee for new restaurants
          </p>
          {editing?.kind === "free_month" ? (
            editor("Free month in days", "e.g. 30")
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              disabled={pending}
              onClick={() =>
                setEditing({
                  kind: "free_month",
                  value: String(data.freeMonthDays),
                })
              }
            >
              Change free month
            </Button>
          )}
        </div>

        {data.history.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">
              Recent pricing changes
            </summary>
            <ul className="text-muted-foreground mt-2 flex flex-col gap-1 text-xs">
              {data.history.map((h, i) => (
                <li key={i}>
                  {new Date(h.changedAt).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}{" "}
                  ·{" "}
                  {h.change === "free_month"
                    ? `Free month: ${h.oldValue} → ${h.newValue} days`
                    : h.change === "fee"
                      ? `${h.planName ?? "A plan"} fee: ${formatFeeBps(Number(h.oldValue))} → ${formatFeeBps(Number(h.newValue))}`
                      : `${h.planName ?? "A plan"} price: ${formatMonthlyPrice(Number(h.oldValue), "USD")} → ${formatMonthlyPrice(Number(h.newValue), "USD")}`}
                </li>
              ))}
            </ul>
          </details>
        )}

        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Make this change?</AlertDialogTitle>
              <AlertDialogDescription>{summary()}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Not yet</AlertDialogCancel>
              <Button type="button" disabled={pending} onClick={save}>
                {pending ? "Saving…" : "Yes, change it"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
