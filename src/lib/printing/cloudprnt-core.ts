import type { StarFormat } from "./star-commands";

/**
 * Star CloudPRNT, the part with no database in it: reading what a printer
 * sends and deciding what to answer. No `server-only`, per the
 * extract-the-core convention; src/app/api/cloudprnt/[token]/route.ts does
 * the HTTP.
 *
 * The exchange, every few seconds:
 *   1. POST (JSON)   the printer's status. We answer jobReady, and when a
 *                    job is waiting, the one media type to fetch it in and
 *                    a jobToken (the job's id).
 *   2. GET  ?mac=&type=&token=      the job's bytes.
 *   3. DELETE ?mac=&code=&token=    "printed" (code 2xx) or why not.
 * The first poll from a printer, and once a day after, asks it what it is
 * (ClientType) and what it can print (Encodings) instead.
 */

export interface PollBody {
  printerMAC?: string;
  statusCode?: string;
  status?: string;
  printingInProgress?: boolean;
  clientAction?: { request?: string; result?: unknown }[];
}

/** What a POST said, cleaned up. Anything unexpected is simply absent. */
export function parsePoll(body: unknown): {
  mac: string | null;
  statusCode: string | null;
  clientType: string | null;
  encodings: string | null;
} {
  const b = (body && typeof body === "object" ? body : {}) as PollBody;
  const mac =
    typeof b.printerMAC === "string" &&
    /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(b.printerMAC)
      ? b.printerMAC.toLowerCase()
      : null;
  const statusCode =
    typeof b.statusCode === "string"
      ? decodeCode(b.statusCode).slice(0, 60)
      : null;
  let clientType: string | null = null;
  let encodings: string | null = null;
  for (const action of Array.isArray(b.clientAction) ? b.clientAction : []) {
    if (typeof action?.result !== "string") continue;
    if (action.request === "ClientType")
      clientType = action.result.slice(0, 100);
    if (action.request === "Encodings") encodings = action.result.slice(0, 500);
  }
  return { mac, statusCode, clientType, encodings };
}

/** "200%20OK" (as some printers double-encode it) or "200 OK". */
export function decodeCode(code: string): string {
  try {
    return decodeURIComponent(code);
  } catch {
    return code;
  }
}

/** A DELETE's code: whether the job printed. */
export function printedOk(code: string | null): boolean {
  return code !== null && decodeCode(code).trim().startsWith("2");
}

export interface PrinterFormat {
  mediaType: string;
  format: StarFormat;
  columns: number;
  utf8: boolean;
}

/**
 * How to talk to a printer, from what it reported. The same choice as
 * Star's WooCommerce plugin: impact (linematrix, 42 columns) before Line
 * Mode, then StarPRNT, then plain text; 32 columns on a 58mm mC-Print2;
 * UTF-8 on the models Star recommends it for.
 */
export function chooseFormat(
  encodings: string | null,
  clientType: string | null,
): PrinterFormat {
  const offered = (encodings ?? "")
    .split(/[;,]/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const type = clientType ?? "";
  const utf8 = /mC-Print|TSP100IV|TSP143IV|TSP654/i.test(type);
  const twoInch = /mC-Print2/i.test(type);

  if (offered.includes("application/vnd.star.linematrix")) {
    return {
      mediaType: "application/vnd.star.linematrix",
      format: "line",
      columns: 42,
      utf8: false,
    };
  }
  if (offered.includes("application/vnd.star.line")) {
    return {
      mediaType: "application/vnd.star.line",
      format: "line",
      columns: twoInch ? 32 : 48,
      utf8,
    };
  }
  if (offered.includes("application/vnd.star.starprnt")) {
    return {
      mediaType: "application/vnd.star.starprnt",
      format: "starprnt",
      columns: twoInch ? 32 : 48,
      utf8,
    };
  }
  return {
    mediaType: "text/plain",
    format: "text",
    columns: twoInch ? 32 : 48,
    utf8: true,
  };
}

/** For a GET whose type differs from ours: the format that type means. */
export function formatForMediaType(
  mediaType: string | null,
  fallback: PrinterFormat,
): PrinterFormat {
  switch ((mediaType ?? "").toLowerCase()) {
    case "application/vnd.star.linematrix":
      return {
        ...fallback,
        mediaType: "application/vnd.star.linematrix",
        format: "line",
      };
    case "application/vnd.star.line":
      return {
        ...fallback,
        mediaType: "application/vnd.star.line",
        format: "line",
      };
    case "application/vnd.star.starprnt":
      return {
        ...fallback,
        mediaType: "application/vnd.star.starprnt",
        format: "starprnt",
      };
    case "text/plain":
      return {
        ...fallback,
        mediaType: "text/plain",
        format: "text",
        utf8: true,
      };
    default:
      return fallback;
  }
}

/** How long a printer's self-description is trusted before asking again. */
export const INFO_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** A job fetched but never confirmed is offered again after this long. */
export const SENT_RETRY_MS = 90 * 1000;
/** ...up to this many times, then marked failed. */
export const MAX_ATTEMPTS = 5;

/** A printer polling within this long counts as online. */
export const ONLINE_WITHIN_MS = 60 * 1000;

export type PollReply =
  | { jobReady: false; clientAction?: { request: string }[] }
  | {
      jobReady: true;
      mediaTypes: string[];
      jobToken: string;
      deleteMethod: "DELETE";
    };

/** Whether to ask the printer what it is before offering it anything. */
export function needsInfo(
  printer: { encodings: string | null; encodings_at: string | null },
  now: Date,
): boolean {
  if (!printer.encodings || !printer.encodings_at) return true;
  return (
    now.getTime() - new Date(printer.encodings_at).getTime() > INFO_MAX_AGE_MS
  );
}

export function pollReply(options: {
  askInfo: boolean;
  job: { id: string } | null;
  format: PrinterFormat;
}): PollReply {
  if (options.askInfo) {
    return {
      jobReady: false,
      clientAction: [{ request: "ClientType" }, { request: "Encodings" }],
    };
  }
  if (!options.job) return { jobReady: false };
  return {
    jobReady: true,
    mediaTypes: [options.format.mediaType],
    jobToken: options.job.id,
    deleteMethod: "DELETE",
  };
}

export function isOnline(lastSeenAt: string | null, now: Date): boolean {
  if (!lastSeenAt) return false;
  return now.getTime() - new Date(lastSeenAt).getTime() <= ONLINE_WITHIN_MS;
}
