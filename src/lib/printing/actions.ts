"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getRequestOrigin } from "@/lib/tables/qr";
import { reportError } from "@/lib/observability/report";

/**
 * Setting up network printers and printing by hand. Every rule (who may,
 * which printers, whose orders) lives in the database functions of
 * 20261112090000_cloudprnt_printers.sql; these check shapes and call them.
 *
 * A printer's URL holds its token, shown once here when the printer is
 * added (or its URL is replaced) and never stored in a readable form.
 */

export type PrinterResult = { ok: true } | { ok: false; error: string };
export type PrinterUrlResult =
  { ok: true; url: string } | { ok: false; error: string };
export type PrintResult =
  { ok: true; printers: number } | { ok: false; error: string };

type Rpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

const SETTINGS_PATH = "/dashboard/settings/printers";

async function rpc(): Promise<Rpc> {
  const supabase = await createClient();
  return supabase.rpc.bind(supabase) as unknown as Rpc;
}

function message(raw: string, fallback: string): string {
  const match = /^(PRINTER_[A-Z_]+|PRINT_[A-Z_]+):\s*(.*)$/.exec(raw);
  return match ? match[2] : fallback;
}

async function printerUrl(token: string): Promise<string> {
  return `${await getRequestOrigin()}/api/cloudprnt/${token}`;
}

const addSchema = z.object({
  restaurantId: z.uuid(),
  name: z.string().trim().min(1, "Give the printer a name.").max(60),
  role: z.enum(["kitchen", "receipt"]),
  stationId: z.uuid().nullable(),
  opensDrawer: z.boolean(),
});

export async function addPrinter(
  input: z.input<typeof addSchema>,
): Promise<PrinterUrlResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the details.",
    };
  }
  const { restaurantId, name, role, stationId, opensDrawer } = parsed.data;
  const { data, error } = await (
    await rpc()
  )("create_printer", {
    p_restaurant_id: restaurantId,
    p_name: name,
    p_role: role,
    p_station_id: stationId,
    p_opens_drawer: opensDrawer,
  });
  const row = (data as { token: string }[] | null)?.[0];
  if (error || !row) {
    if (error && !/^PRINTER_/.test(error.message)) {
      reportError(error, { scope: "printing.add" });
    }
    return {
      ok: false,
      error: message(error?.message ?? "", "Couldn't add the printer."),
    };
  }
  revalidatePath(SETTINGS_PATH);
  return { ok: true, url: await printerUrl(row.token) };
}

const updateSchema = z.object({
  printerId: z.uuid(),
  name: z.string().trim().min(1, "Give the printer a name.").max(60),
  stationId: z.uuid().nullable(),
  autoPrint: z.boolean(),
  opensDrawer: z.boolean(),
  isActive: z.boolean(),
});

export async function updatePrinter(
  input: z.input<typeof updateSchema>,
): Promise<PrinterResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the details.",
    };
  }
  const p = parsed.data;
  const { error } = await (
    await rpc()
  )("update_printer", {
    p_printer_id: p.printerId,
    p_name: p.name,
    p_station_id: p.stationId,
    p_auto_print: p.autoPrint,
    p_opens_drawer: p.opensDrawer,
    p_is_active: p.isActive,
  });
  if (error)
    return { ok: false, error: message(error.message, "Couldn't save that.") };
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

export async function deletePrinter(printerId: string): Promise<PrinterResult> {
  if (!z.uuid().safeParse(printerId).success) {
    return { ok: false, error: "Printer not found." };
  }
  const { error } = await (
    await rpc()
  )("delete_printer", { p_printer_id: printerId });
  if (error)
    return { ok: false, error: message(error.message, "Couldn't remove it.") };
  revalidatePath(SETTINGS_PATH);
  return { ok: true };
}

/** A new URL for the printer; the old one stops working straight away. */
export async function replacePrinterUrl(
  printerId: string,
): Promise<PrinterUrlResult> {
  if (!z.uuid().safeParse(printerId).success) {
    return { ok: false, error: "Printer not found." };
  }
  const { data, error } = await (
    await rpc()
  )("rotate_printer_token", {
    p_printer_id: printerId,
  });
  if (error || typeof data !== "string") {
    return {
      ok: false,
      error: message(error?.message ?? "", "Couldn't make a new URL."),
    };
  }
  revalidatePath(SETTINGS_PATH);
  return { ok: true, url: await printerUrl(data) };
}

const printSchema = z.object({
  restaurantId: z.uuid(),
  kind: z.enum(["kitchen_ticket", "bill", "receipt", "drawer", "test"]),
  orderIds: z.array(z.uuid()).max(50).optional(),
  paymentId: z.uuid().optional(),
  printerId: z.uuid().optional(),
});

/**
 * Prints by hand: a ticket again, a table's bill, a receipt, the drawer,
 * a test page. Says how many printers it went to; 0 means none is set up
 * for that kind of printing.
 */
export async function requestPrint(
  input: z.input<typeof printSchema>,
): Promise<PrintResult> {
  const parsed = printSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "That can't be printed." };
  const p = parsed.data;
  const { data, error } = await (
    await rpc()
  )("request_print", {
    p_restaurant_id: p.restaurantId,
    p_kind: p.kind,
    p_order_ids: p.orderIds ?? null,
    p_payment_id: p.paymentId ?? null,
    p_printer_id: p.printerId ?? null,
  });
  if (error) {
    if (!/^PRINT_/.test(error.message))
      reportError(error, { scope: "printing.request" });
    return {
      ok: false,
      error: message(error.message, "Couldn't send that to the printer."),
    };
  }
  return { ok: true, printers: Number(data ?? 0) };
}
