import type { HistoryFilters } from "@/lib/orders/history-filters";

/**
 * The order history search box.
 *
 * A plain GET form, not a client component: submitting navigates to the
 * same page with `?q=`, which is exactly what the filters already read.
 * That means it works with JavaScript disabled, the result is a real URL
 * a manager can bookmark or send to someone, and the back button behaves.
 *
 * The current range and status ride along as hidden fields so searching
 * narrows what you are already looking at instead of resetting it. They
 * are only rendered when set, so a default view produces a clean
 * `?q=biryani` rather than a URL full of empty parameters.
 */
export function OrderSearchForm({ filters }: { filters: HistoryFilters }) {
  return (
    <form action="/dashboard/orders" className="flex flex-wrap gap-2">
      {filters.range !== "today" && (
        <input type="hidden" name="range" value={filters.range} />
      )}
      {filters.status && (
        <input type="hidden" name="status" value={filters.status} />
      )}

      <label htmlFor="order-search" className="sr-only">
        Search orders by number or dish
      </label>
      <input
        id="order-search"
        name="q"
        type="search"
        defaultValue={filters.search}
        placeholder="Order number or dish — e.g. 42, or biryani"
        className="border-input bg-background focus-visible:ring-ring min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
      />
      <button
        type="submit"
        className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium"
      >
        Search
      </button>
      {filters.search && (
        <a
          href="/dashboard/orders"
          className="text-muted-foreground hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
        >
          Clear
        </a>
      )}
    </form>
  );
}
