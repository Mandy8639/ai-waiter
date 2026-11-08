import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { offlineMenuNote } from "@/lib/offline/core";

/**
 * The guest menu worker's rules (public/r/sw-rules.js, offline mode phase
 * 2): it keeps copies of the menu, dish pages, the app's built files and
 * photos, and nothing personal or staff-side. The file is plain browser
 * JavaScript, so it's run here against a stand-in `self`, as the worker
 * runs it with importScripts().
 */
type Classify = (
  request: {
    method: string;
    url: string;
    mode?: string;
    destination?: string;
    headers?: { get: (name: string) => string | null };
  },
  origin: string,
) => string;

const fakeSelf: { TablesideSwRules?: { classify: Classify } } = {};
new Function(
  "self",
  readFileSync(path.resolve(process.cwd(), "public/r/sw-rules.js"), "utf8"),
)(fakeSelf);
const classify = fakeSelf.TablesideSwRules!.classify;

const ORIGIN = "https://tableside.menu";
const page = (p: string, extra: Partial<Parameters<Classify>[0]> = {}) =>
  classify(
    {
      method: "GET",
      url: ORIGIN + p,
      mode: "navigate",
      destination: "document",
      headers: { get: () => null },
      ...extra,
    },
    ORIGIN,
  );

describe("guest worker: what it keeps a copy of", () => {
  it.each([
    "/r/lantern-table-demo",
    "/r/lantern-table-demo/",
    "/r/lantern-table-demo/menu",
    "/r/lantern-table-demo/item/3bc3b153-648b-45e8-8ba1-6bbe0e3201ef",
  ])("saves the page %s", (p) => {
    expect(page(p)).toBe("page");
  });

  it.each([
    "/r/lantern-table-demo/cart",
    "/r/lantern-table-demo/order/abc",
    "/r/lantern-table-demo/orders",
    "/r/lantern-table-demo/receipt/abc",
    "/r/lantern-table-demo/split/abc",
    "/r/lantern-table-demo/reserve",
    "/r/lantern-table-demo/table/0e0c1f7e-token",
    "/dashboard",
    "/dashboard/kitchen",
    "/login",
    "/",
  ])("never saves %s", (p) => {
    expect(page(p)).toBe("none");
  });

  it("leaves Next's in-app page fetches and every non-GET alone", () => {
    expect(page("/r/x/menu", { mode: "cors" })).toBe("none");
    expect(page("/r/x/menu?_rsc=abc")).toBe("none");
    expect(page("/r/x/menu", { headers: { get: () => "1" } })).toBe("none");
    expect(page("/r/x/menu", { method: "POST" })).toBe("none");
  });

  it("keeps the app's built files and pictures", () => {
    const get = (url: string, destination = "script") =>
      classify({ method: "GET", url, mode: "no-cors", destination }, ORIGIN);
    expect(get(`${ORIGIN}/_next/static/chunks/app-123.js`)).toBe("static");
    expect(get(`${ORIGIN}/_next/image?url=x`, "image")).toBe("image");
    expect(get(`${ORIGIN}/chef/hello.webp`, "image")).toBe("image");
    expect(
      get(
        "https://abc.supabase.co/storage/v1/object/public/menu/dish.webp",
        "image",
      ),
    ).toBe("image");
    // Another site's script or data: no.
    expect(get("https://cdn.example.com/x.js")).toBe("none");
    expect(get(`${ORIGIN}/api/anything`, "")).toBe("none");
  });
});

describe("the note on a guest page", () => {
  const at = Date.UTC(2026, 10, 7, 19, 40);

  it("says it's the saved menu, and when, when offline", () => {
    expect(
      offlineMenuNote({ savedAt: at, offline: true, timeZone: "UTC" }),
    ).toBe(
      "You're offline. This is the menu saved on your phone at 7:40 PM. Prices and what's available are checked when you order.",
    );
  });

  it("says when a slow connection got the saved copy", () => {
    expect(
      offlineMenuNote({ savedAt: at, offline: false, timeZone: "UTC" }),
    ).toMatch(/connection was slow/);
  });

  it("says offline with no saved copy, and nothing when all is well", () => {
    expect(offlineMenuNote({ savedAt: null, offline: true })).toMatch(
      /You're offline/,
    );
    expect(offlineMenuNote({ savedAt: null, offline: false })).toBeNull();
  });
});
