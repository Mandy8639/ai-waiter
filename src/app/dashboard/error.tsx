"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { reportClientError } from "@/lib/observability/report-client";

/**
 * A failure inside a dashboard page. The sidebar and header stay, so the
 * owner can retry or go elsewhere without losing their place.
 */
export default function DashboardError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
    reportClientError(error, {
      scope: "client.dashboard-error",
      digest: error.digest,
    });
  }, [error]);

  return (
    <EmptyState
      icon={<RefreshCw />}
      title="This page didn't load"
      description="Nothing was changed. It's usually a brief connection problem — try again, and if it keeps happening, the error has been reported."
    >
      <Button onClick={() => retry()}>Try again</Button>
    </EmptyState>
  );
}
