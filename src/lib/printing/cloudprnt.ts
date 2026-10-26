import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { pickupLabel } from "@/lib/pickup/format-core";
import {
  MAX_ATTEMPTS,
  SENT_RETRY_MS,
  printedOk,
  type parsePoll,
} from "./cloudprnt-core";
import {
  billDoc,
  drawerDoc,
  kitchenTicketDoc,
  receiptDoc,
  testDoc,
  type PrintOrder,
  type PrintPayment,
  type PrintRestaurant,
} from "./documents";
import type { PrintDoc } from "./star-commands";

/**
 * The CloudPRNT route's database side. A printer is not a signed-in user:
 * the token in its URL is its only credential, so everything here runs
 * with the service role, scoped to the one printer that token names.
 * printers / print_jobs are newer than database.types.ts, hence the
 * untyped client.
 */

export interface PrinterRow {
  id: string;
  restaurant_id: string;
  name: string;
  role: "kitchen" | "receipt";
  station_id: string | null;
  is_active: boolean;
  client_type: string | null;
  encodings: string | null;
  encodings_at: string | null;
}

interface JobRow {
  id: string;
  kind: "kitchen_ticket" | "receipt" | "bill" | "drawer" | "test";
  order_id: string | null;
  order_ids: string[] | null;
  payment_id: string | null;
  reprint: boolean;
  open_drawer: boolean;
  status: string;
  attempts: number;
}

const JOB_COLUMNS =
  "id, kind, order_id, order_ids, payment_id, reprint, open_drawer, status, attempts";

function db(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

export function hashPrinterToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function findPrinter(token: string): Promise<PrinterRow | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const { data } = await db()
    .from("printers")
    .select(
      "id, restaurant_id, name, role, station_id, is_active, client_type, encodings, encodings_at",
    )
    .eq("token_hash", hashPrinterToken(token))
    .maybeSingle();
  return (data as PrinterRow | null) ?? null;
}

/** Notes the poll: when it was seen, its status, and what it said it is. */
export async function recordPoll(
  printer: PrinterRow,
  poll: ReturnType<typeof parsePoll>,
  now: Date,
): Promise<PrinterRow> {
  const update: Record<string, unknown> = {
    last_seen_at: now.toISOString(),
    last_status: poll.statusCode,
  };
  if (poll.mac) update.mac = poll.mac;
  if (poll.clientType) update.client_type = poll.clientType;
  if (poll.encodings) {
    update.encodings = poll.encodings;
    update.encodings_at = now.toISOString();
  }
  await db().from("printers").update(update).eq("id", printer.id);
  return {
    ...printer,
    client_type: poll.clientType ?? printer.client_type,
    encodings: poll.encodings ?? printer.encodings,
    encodings_at: poll.encodings ? now.toISOString() : printer.encodings_at,
  };
}

async function setJob(jobId: string, update: Record<string, unknown>) {
  await db().from("print_jobs").update(update).eq("id", jobId);
}

/**
 * The next job this printer should print, with its document. Jobs that no
 * longer make sense (a cancelled order, a station with nothing on the
 * order, a reversed payment) are marked skipped on the way; one fetched
 * but never confirmed comes round again, a few times.
 */
export async function nextJob(
  printer: PrinterRow,
  now: Date,
): Promise<{ job: JobRow; doc: PrintDoc } | null> {
  const client = db();
  for (let tries = 0; tries < 10; tries++) {
    const { data: queued } = await client
      .from("print_jobs")
      .select(JOB_COLUMNS)
      .eq("printer_id", printer.id)
      .eq("status", "queued")
      .lte("print_after", now.toISOString())
      .order("created_at", { ascending: true })
      .limit(1);
    let job = (queued?.[0] as JobRow | undefined) ?? null;
    if (!job) {
      const { data: stale } = await client
        .from("print_jobs")
        .select(JOB_COLUMNS)
        .eq("printer_id", printer.id)
        .eq("status", "sent")
        .lt("sent_at", new Date(now.getTime() - SENT_RETRY_MS).toISOString())
        .order("created_at", { ascending: true })
        .limit(1);
      job = (stale?.[0] as JobRow | undefined) ?? null;
    }
    if (!job) return null;

    if (job.attempts >= MAX_ATTEMPTS) {
      await setJob(job.id, { status: "failed" });
      continue;
    }
    const doc = await buildDoc(printer, job, now);
    if (!doc) {
      await setJob(job.id, { status: "skipped" });
      continue;
    }
    return { job, doc };
  }
  return null;
}

/** The job named in a GET, if it is this printer's and still to print. */
export async function claimJob(
  printer: PrinterRow,
  jobId: string,
  now: Date,
): Promise<{ job: JobRow; doc: PrintDoc } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const { data } = await db()
    .from("print_jobs")
    .select(JOB_COLUMNS)
    .eq("id", jobId)
    .eq("printer_id", printer.id)
    .in("status", ["queued", "sent"])
    .maybeSingle();
  const job = data as JobRow | null;
  if (!job) return null;
  const doc = await buildDoc(printer, job, now);
  if (!doc) {
    await setJob(job.id, { status: "skipped" });
    return null;
  }
  await setJob(job.id, {
    status: "sent",
    sent_at: now.toISOString(),
    attempts: job.attempts + 1,
  });
  return { job, doc };
}

/** A DELETE: printed, or put back for another go (until MAX_ATTEMPTS). */
export async function finishJob(
  printer: PrinterRow,
  jobId: string | null,
  code: string | null,
  now: Date,
): Promise<void> {
  if (!jobId || !/^[0-9a-f-]{36}$/i.test(jobId)) return;
  const { data } = await db()
    .from("print_jobs")
    .select("id, attempts")
    .eq("id", jobId)
    .eq("printer_id", printer.id)
    .maybeSingle();
  const job = data as { id: string; attempts: number } | null;
  if (!job) return;
  if (printedOk(code)) {
    await setJob(job.id, {
      status: "printed",
      printed_at: now.toISOString(),
      last_code: code,
    });
  } else {
    await setJob(job.id, {
      status: job.attempts >= MAX_ATTEMPTS ? "failed" : "queued",
      last_code: code,
    });
  }
}

async function loadRestaurant(restaurantId: string): Promise<PrintRestaurant> {
  const { data } = await db()
    .from("restaurants")
    .select("name, address, city, state, postal_code, phone, timezone")
    .eq("id", restaurantId)
    .maybeSingle();
  const r = data as {
    name: string;
    address: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    phone: string | null;
    timezone: string;
  } | null;
  const cityLine = [
    r?.city,
    [r?.state, r?.postal_code].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  return {
    name: r?.name ?? "",
    address: [r?.address, cityLine].filter(Boolean).join(", ") || null,
    phone: r?.phone ?? null,
    timeZone: r?.timezone ?? "UTC",
  };
}

interface LoadedOrder extends PrintOrder {
  id: string;
  status: string;
}

async function loadOrders(
  restaurantId: string,
  orderIds: string[],
  timeZone: string,
): Promise<LoadedOrder[]> {
  const client = db();
  const { data: orderRows } = await client
    .from("orders")
    .select(
      "id, order_number, status, created_at, customer_note, subtotal, discount_total, tax, service_charge, total, currency, table_id, pickup_at, pickup_name",
    )
    .eq("restaurant_id", restaurantId)
    .in("id", orderIds)
    .order("created_at", { ascending: true });
  const orders = (orderRows ?? []) as {
    id: string;
    order_number: number;
    status: string;
    created_at: string;
    customer_note: string | null;
    subtotal: number | string;
    discount_total: number | string;
    tax: number | string;
    service_charge: number | string;
    total: number | string;
    currency: string;
    table_id: string;
    pickup_at: string | null;
    pickup_name: string | null;
  }[];
  if (orders.length === 0) return [];

  const [{ data: itemRows }, { data: tableRows }, { data: adjustmentRows }] =
    await Promise.all([
      client
        .from("order_items")
        .select(
          "id, order_id, quantity, item_name, line_total, station_id, spice_preference, notes, created_at",
        )
        .in(
          "order_id",
          orders.map((o) => o.id),
        )
        .order("created_at", { ascending: true }),
      client
        .from("tables")
        .select("id, table_number, display_name, kind")
        .in("id", [...new Set(orders.map((o) => o.table_id))]),
      // Voids, comps and discounts (20261113090000).
      client
        .from("order_adjustments")
        .select("order_id, order_item_id, kind, quantity, amount")
        .in(
          "order_id",
          orders.map((o) => o.id),
        )
        .is("removed_at", null),
    ]);
  const adjustments = (adjustmentRows ?? []) as {
    order_id: string;
    order_item_id: string | null;
    kind: "void" | "comp" | "discount";
    quantity: number | null;
    amount: number | string;
  }[];
  const unitsOf = (itemId: string, kind: "void" | "comp") =>
    adjustments
      .filter((a) => a.order_item_id === itemId && a.kind === kind)
      .reduce((sum, a) => sum + (a.quantity ?? 0), 0);
  const items = (itemRows ?? []) as {
    id: string;
    order_id: string;
    quantity: number;
    item_name: string;
    line_total: number | string;
    station_id: string | null;
    spice_preference: string | null;
    notes: string | null;
  }[];
  const { data: modifierRows } =
    items.length > 0
      ? await client
          .from("order_item_modifiers")
          .select("order_item_id, modifier_option_name")
          .in(
            "order_item_id",
            items.map((i) => i.id),
          )
      : { data: [] };
  const modifiersByItem = new Map<string, string[]>();
  for (const m of (modifierRows ?? []) as {
    order_item_id: string;
    modifier_option_name: string;
  }[]) {
    const list = modifiersByItem.get(m.order_item_id) ?? [];
    list.push(m.modifier_option_name);
    modifiersByItem.set(m.order_item_id, list);
  }
  const tableById = new Map(
    (
      (tableRows ?? []) as {
        id: string;
        table_number: string;
        display_name: string | null;
        kind: string;
      }[]
    ).map((t) => [t.id, t]),
  );

  return orders.map((o) => {
    const table = tableById.get(o.table_id);
    const placeLabel =
      o.pickup_at && o.pickup_name
        ? pickupLabel(o.pickup_at, o.pickup_name, timeZone)
        : table?.display_name ||
          (table ? `Table ${table.table_number}` : "Order");
    return {
      id: o.id,
      status: o.status,
      orderNumber: o.order_number,
      createdAt: o.created_at,
      placeLabel,
      customerNote: o.customer_note,
      subtotal: Number(o.subtotal),
      discountTotal: Number(o.discount_total),
      orderDiscount: adjustments
        .filter((a) => a.order_id === o.id && a.kind === "discount")
        .reduce((sum, a) => sum + Number(a.amount), 0),
      tax: Number(o.tax),
      serviceCharge: Number(o.service_charge),
      total: Number(o.total),
      currency: o.currency,
      items: items
        .filter((i) => i.order_id === o.id)
        .map((i) => ({
          quantity: i.quantity,
          itemName: i.item_name,
          lineTotal: Number(i.line_total),
          voided: unitsOf(i.id, "void"),
          comped: unitsOf(i.id, "comp"),
          stationId: i.station_id,
          modifiers: modifiersByItem.get(i.id) ?? [],
          spicePreference: i.spice_preference,
          notes: i.notes,
        })),
    };
  });
}

async function buildDoc(
  printer: PrinterRow,
  job: JobRow,
  now: Date,
): Promise<PrintDoc | null> {
  const restaurant = await loadRestaurant(printer.restaurant_id);

  switch (job.kind) {
    case "kitchen_ticket": {
      const [order] = await loadOrders(
        printer.restaurant_id,
        job.order_id ? [job.order_id] : [],
        restaurant.timeZone,
      );
      // Cancelled before it printed: the kitchen board dropped it too.
      if (!order || (order.status === "cancelled" && !job.reprint)) return null;
      let stationName: string | null = null;
      if (printer.station_id) {
        const { data } = await db()
          .from("kitchen_stations")
          .select("name")
          .eq("id", printer.station_id)
          .maybeSingle();
        stationName = (data as { name: string } | null)?.name ?? null;
      }
      return kitchenTicketDoc(order, {
        restaurant,
        stationId: printer.station_id,
        stationName,
        reprint: job.reprint,
      });
    }
    case "bill": {
      const orders = await loadOrders(
        printer.restaurant_id,
        job.order_ids ?? [],
        restaurant.timeZone,
      );
      const open = orders.filter((o) => o.status !== "cancelled");
      return open.length > 0 ? billDoc(open, { restaurant, now }) : null;
    }
    case "receipt": {
      if (!job.payment_id) return null;
      const client = db();
      const [{ data: paymentRow }, { data: links }] = await Promise.all([
        client
          .from("order_payments")
          .select(
            "status, method, card_present, amount, tip_amount, currency, paid_at",
          )
          .eq("id", job.payment_id)
          .eq("restaurant_id", printer.restaurant_id)
          .maybeSingle(),
        client
          .from("payment_orders")
          .select("order_id")
          .eq("payment_id", job.payment_id),
      ]);
      const payment = paymentRow as {
        status: string;
        method: PrintPayment["method"];
        card_present: boolean;
        amount: number | string;
        tip_amount: number | string;
        currency: string;
        paid_at: string | null;
      } | null;
      if (!payment || payment.status !== "succeeded") return null;
      const orders = await loadOrders(
        printer.restaurant_id,
        ((links ?? []) as { order_id: string }[]).map((l) => l.order_id),
        restaurant.timeZone,
      );
      if (orders.length === 0) return null;
      return receiptDoc(
        orders,
        {
          method: payment.method,
          cardPresent: payment.card_present,
          amount: Number(payment.amount),
          tip: Number(payment.tip_amount),
          currency: payment.currency,
          paidAt: payment.paid_at ?? now.toISOString(),
        },
        { restaurant, openDrawer: job.open_drawer },
      );
    }
    case "drawer":
      return drawerDoc();
    case "test":
      return testDoc({
        restaurant,
        printerName: printer.name,
        role: printer.role,
        now,
      });
  }
}
