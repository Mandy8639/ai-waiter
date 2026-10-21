import { describe, expect, it } from "vitest";
import {
  EXPORT_TABLES,
  exportFilename,
  withoutOmitted,
  writeExport,
} from "@/lib/export/export-core";

/** "Download all your restaurant's data" (Settings → Your data). */

async function* pagesOf(...pages: Record<string, unknown>[][]) {
  for (const p of pages) yield p;
}

async function collect(gen: AsyncGenerator<string>) {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

describe("writeExport", () => {
  it("streams one valid JSON file, section by section", async () => {
    async function* sections(): AsyncGenerator<
      [string, AsyncIterable<Record<string, unknown>[]>]
    > {
      yield ["menus", pagesOf([{ id: 1 }], [{ id: 2 }])];
      yield ["orders", pagesOf([], [])];
      yield ["tables", pagesOf([{ id: "t", label: 'A "quoted", name' }])];
    }
    const text = await collect(
      writeExport({ format: "x", version: 1 }, sections()),
    );
    expect(JSON.parse(text)).toEqual({
      format: "x",
      version: 1,
      data: {
        menus: [{ id: 1 }, { id: 2 }],
        orders: [],
        tables: [{ id: "t", label: 'A "quoted", name' }],
      },
    });
  });

  it("never ends as valid JSON when a page fails", async () => {
    async function* failing(): AsyncGenerator<Record<string, unknown>[]> {
      yield [{ id: 1 }];
      throw new Error("orders: permission denied");
    }
    async function* sections(): AsyncGenerator<
      [string, AsyncIterable<Record<string, unknown>[]>]
    > {
      yield ["orders", failing()];
    }
    let text = "";
    await expect(async () => {
      for await (const c of writeExport({ format: "x" }, sections())) text += c;
    }).rejects.toThrow(/permission denied/);
    expect(() => JSON.parse(text)).toThrow();
  });
});

describe("export details", () => {
  it("drops internal columns", () => {
    expect(
      withoutOmitted({ id: 1, idempotency_key: "k" }, ["idempotency_key"]),
    ).toEqual({ id: 1 });
  });

  it("names the file after the restaurant and the day", () => {
    expect(
      exportFilename("desi-dhamaka", new Date("2026-10-21T12:00:00Z")),
    ).toBe("desi-dhamaka-data-2026-10-21.json");
    expect(exportFilename('a"b/c', new Date("2026-10-21T00:00:00Z"))).toBe(
      "abc-data-2026-10-21.json",
    );
  });

  it("never exports credentials", () => {
    const names = EXPORT_TABLES.map((t) => t.table);
    for (const secret of [
      "native_push_tokens",
      "push_subscriptions",
      "staff_invitations",
      "customer_sessions",
      "ai_conversation_messages",
    ]) {
      expect(names).not.toContain(secret);
    }
  });
});
