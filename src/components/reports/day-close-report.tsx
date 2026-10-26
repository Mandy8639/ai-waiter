import { formatMoney } from "@/lib/orders/format";
import {
  dayCloseMethodLabel,
  type DayCloseSummary,
} from "@/lib/reports/day-close-core";

/**
 * The closing report's figures: sales and tips by how people paid,
 * refunds, voids, comps and discounts, and who took payment. The same for
 * the open day (live) and a closed one (as it was frozen).
 */
export function DayCloseReport({ summary }: { summary: DayCloseSummary }) {
  const money = (v: number) => formatMoney(v, summary.currency);
  const s = summary;
  const adjustments = (
    [
      ["Voids", s.adjustments.void],
      ["Comps", s.adjustments.comp],
      ["Discounts", s.adjustments.discount],
    ] as const
  ).filter(([, line]) => line.count > 0);

  return (
    <div className="flex flex-col gap-5 text-sm">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(
          [
            ["Sales", s.payments.sales],
            ["Tips", s.payments.tips],
            ["Refunds", s.payments.refunds],
            ["Net", s.payments.net],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-md border p-3">
            <dt className="text-muted-foreground text-xs">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">
              {label === "Refunds" && value > 0 ? "-" : ""}
              {money(value)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground">
        {s.payments.count} {s.payments.count === 1 ? "payment" : "payments"} ·{" "}
        {s.orders} {s.orders === 1 ? "order" : "orders"} paid
        {s.reversed.count > 0
          ? ` · ${s.reversed.count} reversed (${money(s.reversed.amount)})`
          : ""}
      </p>

      {s.by_method.length > 0 && (
        <table className="w-full">
          <thead className="text-muted-foreground text-left text-xs">
            <tr>
              <th className="py-1 font-normal">How they paid</th>
              <th className="py-1 text-right font-normal">Sales</th>
              <th className="py-1 text-right font-normal">Tips</th>
              <th className="py-1 text-right font-normal">Refunds</th>
              <th className="py-1 text-right font-normal">Net</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {s.by_method.map((m) => (
              <tr key={m.method} className="border-t">
                <td className="py-1.5">
                  {dayCloseMethodLabel(m.method)}{" "}
                  <span className="text-muted-foreground">({m.count})</span>
                </td>
                <td className="py-1.5 text-right">{money(m.sales)}</td>
                <td className="py-1.5 text-right">{money(m.tips)}</td>
                <td className="py-1.5 text-right">
                  {m.refunds > 0 ? `-${money(m.refunds)}` : "—"}
                </td>
                <td className="py-1.5 text-right font-medium">
                  {money(m.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {adjustments.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium">Taken off bills</p>
          {adjustments.map(([label, line]) => (
            <p key={label} className="flex justify-between tabular-nums">
              <span>
                {label}{" "}
                <span className="text-muted-foreground">({line.count})</span>
              </span>
              <span>-{money(line.amount)}</span>
            </p>
          ))}
        </div>
      )}

      {s.staff.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="font-medium">Taken by</p>
          {s.staff.map((person) => (
            <p
              key={person.email}
              className="flex justify-between gap-2 tabular-nums"
            >
              <span className="truncate">
                {person.email}{" "}
                <span className="text-muted-foreground">({person.count})</span>
              </span>
              <span>
                {money(person.total)}
                {person.cash > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({money(person.cash)} cash)
                  </span>
                )}
              </span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
