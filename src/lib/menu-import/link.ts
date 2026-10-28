import "server-only";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";
import zlib from "node:zlib";
import { MenuLinkError, isPublicAddress, parseMenuLink } from "./link-core";

/**
 * Fetches the page a menu link points at, for the menu reader
 * (src/lib/menu-import/link-core.ts has the rules; this is the network).
 *
 * node:http with its own `lookup`, rather than fetch(), so the address
 * check runs on the address actually connected to: a name that resolves to
 * a public address when checked and a private one when fetched (DNS
 * rebinding) is still refused.
 */

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/** Resolves like the system does, but refuses any non-public address. */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 0);
    const list = addresses as unknown as LookupAddress[];
    if (list.length === 0 || !list.every((a) => isPublicAddress(a.address))) {
      return callback(
        Object.assign(new Error("address not allowed"), {
          code: "TABLESIDE_BLOCKED_ADDRESS",
        }) as NodeJS.ErrnoException,
        "",
        0,
      );
    }
    if (options.all) return callback(null, list as never);
    callback(null, list[0].address, list[0].family);
  });
};

interface Fetched {
  status: number;
  location?: string;
  contentType: string;
  body: string;
}

function get(url: URL): Promise<Fetched> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      {
        lookup: publicOnlyLookup,
        timeout: TIMEOUT_MS,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TablesideMenuImport/1.0; +https://tableside.menu)",
          Accept:
            "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          response.resume();
          return resolve({
            status,
            location: response.headers.location,
            contentType,
            body: "",
          });
        }
        const encoding = String(response.headers["content-encoding"] ?? "");
        const stream =
          encoding === "gzip"
            ? response.pipe(zlib.createGunzip())
            : encoding === "deflate"
              ? response.pipe(zlib.createInflate())
              : encoding === "br"
                ? response.pipe(zlib.createBrotliDecompress())
                : response;
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            request.destroy();
            reject(
              new MenuLinkError(
                "That page is too large to read. Try the page that shows only the menu.",
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () =>
          resolve({
            status,
            contentType,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        stream.on("error", reject);
      },
    );
    request.on("timeout", () => {
      request.destroy(new MenuLinkError("That page took too long to load."));
    });
    request.on("error", reject);
  });
}

/** The page's HTML (or JSON), following up to three redirects, each checked again. */
export async function fetchMenuPage(
  raw: string,
): Promise<{ url: string; contentType: string; body: string }> {
  let url = parseMenuLink(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let fetched: Fetched;
    try {
      fetched = await get(url);
    } catch (error) {
      if (error instanceof MenuLinkError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      throw new MenuLinkError(
        code === "TABLESIDE_BLOCKED_ADDRESS"
          ? "That link doesn't point to a public website."
          : code === "ENOTFOUND"
            ? "That website couldn't be found. Check the link."
            : "That page couldn't be loaded. Check the link, or upload photos instead.",
      );
    }

    if (fetched.status >= 300 && fetched.status < 400 && fetched.location) {
      url = parseMenuLink(new URL(fetched.location, url).toString());
      continue;
    }
    if (fetched.status === 401 || fetched.status === 403) {
      throw new MenuLinkError(
        "That website doesn't let us read the page. Take screenshots of your menu and upload them instead.",
      );
    }
    if (fetched.status !== 200) {
      throw new MenuLinkError(
        `That page couldn't be loaded (error ${fetched.status}). Check the link.`,
      );
    }
    if (/application\/pdf/i.test(fetched.contentType)) {
      throw new MenuLinkError(
        "That link is a PDF. Download it and upload it above instead.",
      );
    }
    if (!/(text\/html|xhtml|json|text\/plain)/i.test(fetched.contentType)) {
      throw new MenuLinkError("That link isn't a web page with a menu on it.");
    }
    return {
      url: url.toString(),
      contentType: fetched.contentType,
      body: fetched.body,
    };
  }
  throw new MenuLinkError("That link redirects too many times.");
}
