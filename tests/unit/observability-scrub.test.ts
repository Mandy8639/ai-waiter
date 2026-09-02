import { describe, expect, it } from "vitest";
import { scrubHeaders, scrubPath, toError } from "@/lib/observability/scrub";

/**
 * Error reporting sends data to a third party, so this is a disclosure
 * path as much as a debugging one. These tests are about what must never
 * leave the process.
 */

describe("scrubHeaders", () => {
  it("keeps the headers worth debugging with", () => {
    expect(
      scrubHeaders({ "user-agent": "Safari", referer: "https://x.test/menu" }),
    ).toEqual({ "user-agent": "Safari", referer: "https://x.test/menu" });
  });

  it("drops the cookie header", () => {
    // A session cookie would let a reader of the report act as the diner
    // whose payment failed.
    expect(scrubHeaders({ cookie: "sb-access-token=secret" })).toEqual({});
  });

  it("drops authorization and stripe's signature", () => {
    expect(
      scrubHeaders({
        authorization: "Bearer secret",
        "stripe-signature": "t=1,v1=abc",
      }),
    ).toEqual({});
  });

  it("drops anything not named in the allowlist", () => {
    // The point of an allowlist: headers arrive from the client, so a
    // denylist would leak every name nobody thought of — including names
    // an attacker chose.
    expect(scrubHeaders({ "x-made-up-token": "secret" })).toEqual({});
  });

  it("matches header names case-insensitively", () => {
    expect(scrubHeaders({ "User-Agent": "Safari" })).toEqual({
      "user-agent": "Safari",
    });
    expect(scrubHeaders({ Cookie: "sb-access-token=secret" })).toEqual({});
  });

  it("joins repeated headers rather than dropping one", () => {
    expect(scrubHeaders({ "x-forwarded-for": ["1.1.1.1", "2.2.2.2"] })).toEqual(
      {
        "x-forwarded-for": "1.1.1.1, 2.2.2.2",
      },
    );
  });

  it("survives absent values and absent headers", () => {
    expect(scrubHeaders({ "user-agent": undefined })).toEqual({});
    expect(scrubHeaders(undefined)).toEqual({});
  });
});

describe("scrubPath", () => {
  it("keeps a plain path, which is how you find the route", () => {
    expect(scrubPath("/dashboard/reports")).toBe("/dashboard/reports");
  });

  it("redacts the query string wholesale", () => {
    // A table token is a bearer of table access, and a checkout session id
    // identifies a payment. Neither belongs in a third-party system.
    expect(scrubPath("/r/x/table/tok_secret?session_id=cs_live_abc")).toBe(
      "/r/x/table/tok_secret?[redacted]",
    );
  });

  it("redacts even an empty query", () => {
    expect(scrubPath("/menu?")).toBe("/menu?[redacted]");
  });
});

describe("toError", () => {
  it("passes a real Error through untouched", () => {
    const original = new Error("boom");
    expect(toError(original)).toBe(original);
  });

  it("names a Postgres error by its code, which groups far better", () => {
    // Supabase messages often embed an id, so grouping on the message
    // scatters one recurring fault across hundreds of clusters.
    const error = toError({
      message: "DELETE requires a WHERE clause",
      code: "21000",
    });
    expect(error.name).toBe("PostgresError(21000)");
    expect(error.message).toBe("DELETE requires a WHERE clause");
  });

  it("keeps the message when there is no code", () => {
    expect(toError({ message: "plain" }).message).toBe("plain");
  });

  it("wraps a thrown string", () => {
    expect(toError("just a string").message).toBe("just a string");
  });

  it("does not throw on null or undefined", () => {
    // Reporting must never be able to break the thing it observes.
    expect(toError(null).message).toBe("Unknown error");
    expect(toError(undefined).message).toBe("Unknown error");
  });

  it("gives every result a stack, so reports group by call site", () => {
    expect(toError("no stack of its own").stack).toBeTruthy();
  });
});
