/**
 * The full-page "loading" spinner, for loading.tsx files.
 *
 * Each route segment that needs one has its own loading.tsx rendering this,
 * rather than one at the app root. A root loading.tsx wraps every layout
 * below it, so the response starts streaming before a layout such as
 * /r/[restaurantSlug] can call notFound(), and an unknown restaurant then
 * answers 200 instead of 404 (node_modules/next/dist/docs, "Status codes").
 */
export function PageSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-24">
      <div
        role="status"
        aria-label="Loading"
        className="border-muted-foreground/30 border-t-foreground h-8 w-8 animate-spin rounded-full border-2"
      />
    </div>
  );
}
