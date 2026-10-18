import Link from "next/link";
import { CircleAlert, Info, PauseCircle } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BillingNotice } from "@/lib/billing/trial-core";

const TONES = {
  info: { box: "bg-muted/60", icon: Info },
  warning: {
    box: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
    icon: CircleAlert,
  },
  danger: {
    box: "border-destructive/40 bg-destructive/10",
    icon: PauseCircle,
  },
} as const;

/** The free-month and plan notice at the top of dashboard pages. */
export function BillingBanner({ notice }: { notice: BillingNotice }) {
  const tone = TONES[notice.tone];
  const Icon = tone.icon;
  return (
    <div
      role={notice.tone === "danger" ? "alert" : "note"}
      className={cn(
        "mb-6 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        tone.box,
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p>
          <span className="font-medium">{notice.title}.</span> {notice.body}
        </p>
        {notice.action && (
          <Link
            href={notice.action.href}
            className={buttonVariants({
              size: "sm",
              variant: notice.tone === "danger" ? "default" : "outline",
              className: "w-fit shrink-0",
            })}
          >
            {notice.action.label}
          </Link>
        )}
      </div>
    </div>
  );
}
