import {
  costTotals,
  formatSpend,
  perChat,
  type CostRow,
} from "@/lib/admin/cost-report-core";

/**
 * One week's AI cost per restaurant, on the Spending card (docs/admin.md,
 * Phase 4). A "chat" is one diner message the waiter answered; the cost
 * column is every AI job for that restaurant, not only the waiter.
 */
export function CostTable({
  title,
  rows,
}: {
  title: string;
  rows: CostRow[] | null;
}) {
  if (rows === null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground text-sm">
          Couldn&apos;t load the cost table just now.
        </p>
      </section>
    );
  }
  const totals = costTotals(rows);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">No AI use yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Restaurant</th>
                <th className="px-3 py-2 text-right font-medium">
                  Waiter chats
                </th>
                <th className="px-3 py-2 text-right font-medium">AI cost</th>
                <th className="px-3 py-2 text-right font-medium">Per chat</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => (
                <tr key={row.restaurantId ?? "platform"}>
                  <td
                    className={
                      "px-3 py-2" +
                      (row.restaurantId === null
                        ? " text-muted-foreground"
                        : "")
                    }
                  >
                    {row.name}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {row.waiterChats}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatSpend(row.costUsd)}
                    {row.unpriced > 0 && " *"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {perChat(row)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t font-medium">
              <tr>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {totals.waiterChats}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatSpend(totals.costUsd)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {totals.perChatUsd === null
                    ? "–"
                    : formatSpend(totals.perChatUsd)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {totals.unpriced > 0 && (
        <p className="text-muted-foreground text-xs">
          * {totals.unpriced} use{totals.unpriced === 1 ? "" : "s"} came back
          without a cost and aren&apos;t counted. OpenRouter&apos;s own total
          above includes them.
        </p>
      )}
    </section>
  );
}
