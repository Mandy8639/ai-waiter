import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ReactNode } from "react";
import {
  formatUsd,
  limitUsedPercent,
  nothingReported,
  resetLabel,
  type Spending,
} from "@/lib/admin/spending-core";

/**
 * The Admin page's Spending card (docs/admin.md, Phase 3): OpenRouter's
 * own figures for the app's key, read live on each view. The limit is
 * set on OpenRouter and only shown here: a bug in this page can't raise
 * it, which is the point of keeping it there.
 */
export function SpendingCard({
  spending,
  children,
}: {
  spending: Spending;
  /** The per-restaurant cost tables, under OpenRouter's figures. */
  children?: ReactNode;
}) {
  const percent = limitUsedPercent(spending);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Spending</CardTitle>
        <CardDescription>
          What OpenRouter reports for this app&apos;s key, right now. Free
          models cost nothing; only paid ones show up here.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {nothingReported(spending) ? (
          <p className="text-muted-foreground rounded-md border p-3 text-sm">
            Couldn&apos;t reach OpenRouter just now, so spending isn&apos;t
            shown. That doesn&apos;t mean nothing was spent. Reload in a minute,
            or check openrouter.ai/activity.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Figure
                label="Credit left"
                value={formatUsd(spending.balanceUsd)}
              />
              <Figure
                label="Spent this month"
                value={formatUsd(spending.monthUsd)}
              />
              <Figure
                label="Spent today"
                value={formatUsd(spending.todayUsd)}
              />
            </dl>
            {spending.limitUsd === null ? (
              <p className="text-muted-foreground text-sm">
                No spending limit is set on this key. Set one on
                openrouter.ai/keys so a mistake can never overspend.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm">
                  Limit {formatUsd(spending.limitUsd)}{" "}
                  {resetLabel(spending.limitReset)}
                  {spending.limitRemainingUsd !== null &&
                    ` · ${formatUsd(spending.limitRemainingUsd)} left`}
                </p>
                {percent !== null && (
                  <div
                    className="bg-muted h-2 w-full overflow-hidden rounded-full"
                    role="meter"
                    aria-label="Share of the spending limit used"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                  >
                    <div
                      className={
                        "h-full rounded-full " +
                        (percent >= 80 ? "bg-destructive" : "bg-primary")
                      }
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                )}
                <p className="text-muted-foreground text-xs">
                  The limit is set on OpenRouter, not here, so nothing on this
                  page can raise it.
                </p>
              </div>
            )}
          </>
        )}
        {children}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
