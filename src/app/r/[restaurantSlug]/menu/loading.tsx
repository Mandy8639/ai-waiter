import { Skeleton } from "@/components/ui/skeleton";

/**
 * The menu's shape while it loads — title, the waiter card, search, chips
 * and a few dish rows — so a slow connection shows the page arriving
 * rather than a spinner in an empty screen.
 */
export default function MenuLoading() {
  return (
    <div
      className="flex flex-1 flex-col gap-6"
      role="status"
      aria-label="Loading the menu"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-9 w-2/3" />
      </div>
      <Skeleton className="h-36 w-full rounded-2xl" />
      <Skeleton className="h-11 w-full rounded-xl" />
      <div className="flex gap-2">
        {[64, 72, 56, 80].map((width) => (
          <Skeleton
            key={width}
            className="h-9 rounded-full"
            style={{ width }}
          />
        ))}
      </div>
      <div className="flex flex-col gap-3">
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex flex-col gap-2 rounded-xl border p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-4/5" />
            <Skeleton className="mt-1 h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
