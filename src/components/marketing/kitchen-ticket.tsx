import { cn } from "@/lib/utils";

export interface TicketLine {
  qty: number;
  name: string;
  note?: string;
}

/**
 * The site's signature: a thermal kitchen ticket, the thing a guest's order
 * becomes. Purely illustrative — example dishes, never a real restaurant's.
 */
export function KitchenTicket({
  table,
  orderNumber,
  time,
  lines,
  footer,
  className,
  style,
}: {
  table: string;
  orderNumber: number;
  time: string;
  lines: TicketLine[];
  footer?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    // The shadow sits on a wrapper: the torn-edge mask would clip it.
    <div
      className={cn(
        "w-64 drop-shadow-[0_14px_22px_oklch(0.2_0.02_40/0.22)]",
        className,
      )}
      style={style}
    >
      <div
        className="mk-ticket px-5 pt-5 text-[0.8rem]"
        role="img"
        aria-label={`Example kitchen ticket for ${table}: ${lines
          .map((l) => `${l.qty} ${l.name}`)
          .join(", ")}`}
      >
        <div className="flex items-baseline justify-between">
          <span className="text-base font-semibold tracking-tight">
            {table}
          </span>
          <span>#{orderNumber}</span>
        </div>
        <div className="mt-1 flex justify-between opacity-70">
          <span>DINE IN</span>
          <span>{time}</span>
        </div>
        <hr className="mk-ticket-rule my-3" />
        <ul className="flex flex-col gap-2">
          {lines.map((line) => (
            <li key={line.name}>
              <div className="flex gap-3">
                <span className="font-semibold">{line.qty}×</span>
                <span className="uppercase">{line.name}</span>
              </div>
              {line.note ? (
                <div className="pl-7 opacity-75">↳ {line.note}</div>
              ) : null}
            </li>
          ))}
        </ul>
        {footer ? (
          <>
            <hr className="mk-ticket-rule my-3" />
            <p className="text-center opacity-70">{footer}</p>
          </>
        ) : null}
      </div>
    </div>
  );
}
