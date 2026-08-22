"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center px-6 py-24 antialiased">
        <main className="flex w-full max-w-md flex-col items-center gap-4 text-center">
          <p className="text-sm font-medium tracking-wide text-neutral-500 uppercase">
            Critical error
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900">
            Something went wrong
          </h1>
          <p className="text-sm text-neutral-500">
            The application failed to load. You can try again.
          </p>
          <button
            onClick={reset}
            className="mt-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-50"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
