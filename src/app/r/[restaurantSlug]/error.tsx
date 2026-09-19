"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { reportClientError } from "@/lib/observability/report-client";

/**
 * A diner-facing failure inside a restaurant's pages. Rendered inside the
 * restaurant layout, so the header — and the way back to the menu — stays.
 * `retry` re-fetches the segment (this Next.js fork's recommended
 * recovery; see node_modules/next/dist/docs/.../error.md).
 */
export default function DinerError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
    reportClientError(error, {
      scope: "client.diner-error",
      digest: error.digest,
    });
  }, [error]);

  return (
    <EmptyState
      icon={<RefreshCw />}
      title="Something went wrong loading this page"
      description="It's usually a brief connection problem. Try again — your order so far is saved."
    >
      <Button size="lg" onClick={() => retry()}>
        Try again
      </Button>
    </EmptyState>
  );
}
