"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/observability/report-client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    reportClientError(error, { scope: "client.error", digest: error.digest });
  }, [error]);

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-24">
      <main className="flex w-full max-w-md flex-col items-center gap-4 text-center">
        <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
          Error
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Something went wrong
        </h1>
        <p className="text-muted-foreground text-sm">
          An unexpected error occurred. You can try again.
        </p>
        <Button onClick={reset} className="mt-2">
          Try again
        </Button>
      </main>
    </div>
  );
}
