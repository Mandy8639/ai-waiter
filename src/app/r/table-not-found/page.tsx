export const metadata = {
  title: "QR code not recognized — Tableside",
};

/**
 * Also the redirect target when session creation is throttled
 * (?reason=busy — src/lib/customer/rate-limit.ts) — a distinct, friendlier
 * message from "this code doesn't exist at all," even though the route is
 * shared. A dedicated page for a case that should be rare in real use
 * would be over-building; this one extra branch keeps it simple.
 */
export default async function TableNotFoundPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason } = await searchParams;
  const isBusy = reason === "busy";

  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <main className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <p className="text-muted-foreground text-sm font-medium tracking-wide uppercase">
          {isBusy ? "One moment" : "Not found"}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">
          {isBusy
            ? "This table is getting a lot of scans right now"
            : "We couldn’t find that table"}
        </h1>
        <p className="text-muted-foreground text-sm">
          {isBusy
            ? "Please wait a minute and scan again. If this keeps happening, ask a staff member for help."
            : "This QR code may have been replaced, or the table may no longer be active. Please ask a staff member for a new code."}
        </p>
      </main>
    </div>
  );
}
