import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  escapeHtml,
  renderCardPaymentsDisabled,
  renderDailySummary,
  renderDinerPaymentFailed,
  renderSubscriptionPastDue,
  type DailySummaryData,
  type EmailMessage,
} from "@/lib/email/templates";
import {
  dayLabel,
  idempotencyKey,
  localDate,
  localYesterday,
  sendToOwners,
  type EmailDeps,
  type ProviderResult,
  type Recipient,
} from "@/lib/email/send-core";
import { sendWithResend } from "@/lib/email/resend";
import { isAuthorizedCronRequest } from "@/lib/email/cron-auth";

/**
 * Owner email (phase F): the words, the once-only rule, the restaurant's
 * own calendar, the Resend call and the boundary around the service-role
 * sender. The SQL half is tests/integration/db/owner-email.test.ts.
 */

const summary: DailySummaryData = {
  restaurantName: "Nashta",
  dayLabel: "Monday, September 28",
  currency: "USD",
  orderCount: 12,
  orderValue: 184.5,
  cancelledCount: 1,
  tableRequestCount: 3,
  topItems: [
    { name: "Masala Dosa", quantity: 7 },
    { name: "Chai", quantity: 5 },
  ],
  reportsUrl: "https://tableside.menu/dashboard/reports",
  settingsUrl: "https://tableside.menu/dashboard/settings",
};

describe("the daily summary", () => {
  it("puts the answer in the subject line", () => {
    expect(renderDailySummary(summary).subject).toBe(
      "Nashta yesterday: 12 orders, $184.50",
    );
  });

  it("says one order, not one orders", () => {
    const message = renderDailySummary({
      ...summary,
      orderCount: 1,
      orderValue: 9.99,
      cancelledCount: 0,
      tableRequestCount: 0,
    });
    expect(message.subject).toBe("Nashta yesterday: 1 order, $9.99");
    expect(message.text).toContain("1 order worth $9.99.");
    expect(message.text).not.toMatch(/cancelled|asked for a waiter/);
  });

  it("gives the average, the cancellations, the table requests and the top dishes", () => {
    const { text, html } = renderDailySummary(summary);
    expect(text).toContain("That's $15.38 an order on average.");
    expect(text).toContain("1 order was cancelled");
    expect(text).toContain("asked for a waiter or the bill 3 times");
    expect(text).toContain("1. Masala Dosa x 7");
    expect(html).toContain("Masala Dosa &times; 7");
  });

  it("is honest that order value is not money taken", () => {
    expect(renderDailySummary(summary).text).toContain(
      "whether or not they've been paid yet",
    );
  });

  it("shows at most three dishes", () => {
    const { text } = renderDailySummary({
      ...summary,
      topItems: ["A", "B", "C", "D"].map((name) => ({ name, quantity: 1 })),
    });
    expect(text).toContain("3. C x 1");
    expect(text).not.toContain("D x 1");
  });

  it("never lets a dish name become markup", () => {
    const { html } = renderDailySummary({
      ...summary,
      restaurantName: `Tom & Jerry's`,
      topItems: [{ name: `<img src=x onerror="alert(1)">`, quantity: 1 }],
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("Tom &amp; Jerry&#39;s");
  });
});

describe("payment alerts", () => {
  const base = {
    restaurantName: "Nashta",
    settingsUrl: "https://tableside.menu/dashboard/settings",
  };

  it("names every order a failed tab payment covered", () => {
    const tab = renderDinerPaymentFailed({
      ...base,
      orderNumbers: [14, 12],
      amount: 42,
      currency: "USD",
      ordersUrl: "https://tableside.menu/dashboard/orders",
    });
    expect(tab.subject).toBe(
      "A payment of $42.00 for orders #12, #14 at Nashta failed",
    );
    expect(tab.text).toContain("You have not been paid for them.");

    const single = renderDinerPaymentFailed({
      ...base,
      orderNumbers: [7],
      amount: 9.99,
      currency: "USD",
      ordersUrl: "https://tableside.menu/dashboard/orders",
    });
    expect(single.subject).toContain("for order #7 at");
    expect(single.text).toContain("You have not been paid for it.");

    const unknown = renderDinerPaymentFailed({
      ...base,
      orderNumbers: [],
      amount: 5,
      currency: "USD",
      ordersUrl: "https://tableside.menu/dashboard/orders",
    });
    expect(unknown.subject).toContain("for an order at");
  });

  it("each says what to do and links to it", () => {
    const pastDue = renderSubscriptionPastDue({
      ...base,
      billingUrl: "https://tableside.menu/dashboard/settings",
    });
    expect(pastDue.subject).toMatch(/^Action needed/);
    expect(pastDue.text).toContain("Update payment details:");

    const disabled = renderCardPaymentsDisabled({
      ...base,
      paymentsUrl: "https://tableside.menu/dashboard/payments",
    });
    expect(disabled.text).toContain(
      "See what Stripe needs: https://tableside.menu/dashboard/payments",
    );
  });
});

describe("every email", () => {
  const all: EmailMessage[] = [
    renderDailySummary(summary),
    renderSubscriptionPastDue({
      restaurantName: "Nashta",
      settingsUrl: "https://tableside.menu/dashboard/settings",
      billingUrl: "https://tableside.menu/dashboard/settings",
    }),
    renderCardPaymentsDisabled({
      restaurantName: "Nashta",
      settingsUrl: "https://tableside.menu/dashboard/settings",
      paymentsUrl: "https://tableside.menu/dashboard/payments",
    }),
    renderDinerPaymentFailed({
      restaurantName: "Nashta",
      settingsUrl: "https://tableside.menu/dashboard/settings",
      orderNumbers: [1],
      amount: 1,
      currency: "USD",
      ordersUrl: "https://tableside.menu/dashboard/orders",
    }),
  ];

  it("says why it arrived and links to the setting that stops it", () => {
    for (const message of all) {
      expect(message.text).toContain("You're getting this because");
      expect(message.text).toContain(
        "Change email settings: https://tableside.menu/dashboard/settings",
      );
      expect(message.html).toContain(
        'href="https://tableside.menu/dashboard/settings"',
      );
    }
  });

  it("has a plain-text version and no images or tracking pixels", () => {
    for (const message of all) {
      expect(message.text.length).toBeGreaterThan(50);
      expect(message.html).not.toMatch(/<img/i);
    }
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});

describe("sending once", () => {
  const owners: Recipient[] = [
    { userId: "u1", email: "one@example.com" },
    { userId: "u2", email: "two@example.com" },
  ];
  const message: EmailMessage = { subject: "s", html: "h", text: "t" };

  function fakeDeps(options: {
    claimed?: Set<string>;
    send?: (to: string) => Promise<ProviderResult>;
  }) {
    const claimed = options.claimed ?? new Set<string>();
    const sent: Array<{ to: string; key: string }> = [];
    const recorded: Array<{ id: string; result: ProviderResult }> = [];
    const deps: EmailDeps = {
      claim: async (recipient) => {
        if (claimed.has(recipient.userId)) return null;
        claimed.add(recipient.userId);
        return `dispatch-${recipient.userId}`;
      },
      send: async (to, _message, key) => {
        sent.push({ to, key });
        return options.send ? options.send(to) : { ok: true, id: `re_${to}` };
      },
      record: async (id, result) => {
        recorded.push({ id, result });
      },
    };
    return { deps, sent, recorded, claimed };
  }

  it("claims, sends and records each owner", async () => {
    const { deps, sent, recorded } = fakeDeps({});
    const report = await sendToOwners(deps, {
      kind: "daily_summary",
      dedupeKey: "2026-09-28",
      recipients: owners,
      message,
    });
    expect(report).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(sent).toEqual([
      { to: "one@example.com", key: "daily_summary:2026-09-28:u1" },
      { to: "two@example.com", key: "daily_summary:2026-09-28:u2" },
    ]);
    expect(recorded.map((r) => r.id)).toEqual(["dispatch-u1", "dispatch-u2"]);
  });

  it("sends nothing the second time the same run arrives", async () => {
    const claimed = new Set<string>();
    const first = fakeDeps({ claimed });
    await sendToOwners(first.deps, {
      kind: "daily_summary",
      dedupeKey: "2026-09-28",
      recipients: owners,
      message,
    });
    const second = fakeDeps({ claimed });
    const report = await sendToOwners(second.deps, {
      kind: "daily_summary",
      dedupeKey: "2026-09-28",
      recipients: owners,
      message,
    });
    expect(report).toEqual({ sent: 0, skipped: 2, failed: 0 });
    expect(second.sent).toEqual([]);
  });

  it("keeps going when one owner's email fails, and records the failure", async () => {
    const { deps, sent, recorded } = fakeDeps({
      send: async (to) =>
        to.startsWith("one")
          ? { ok: false, error: "resend 422: invalid" }
          : { ok: true, id: "re_2" },
    });
    const report = await sendToOwners(deps, {
      kind: "subscription_past_due",
      dedupeKey: "sub_1:past_due:2026-10-01",
      recipients: owners,
      message,
    });
    expect(report).toEqual({ sent: 1, skipped: 0, failed: 1 });
    expect(sent).toHaveLength(2);
    expect(recorded[0].result).toEqual({
      ok: false,
      error: "resend 422: invalid",
    });
  });

  it("never throws, whatever the I/O does", async () => {
    const deps: EmailDeps = {
      claim: async () => {
        throw new Error("database down");
      },
      send: async () => {
        throw new Error("unreachable");
      },
      record: async () => {},
    };
    await expect(
      sendToOwners(deps, {
        kind: "daily_summary",
        dedupeKey: "d",
        recipients: owners,
        message,
      }),
    ).resolves.toEqual({ sent: 0, skipped: 0, failed: 2 });

    const throwingSend = fakeDeps({
      send: async () => {
        throw new Error("socket hang up");
      },
    });
    const report = await sendToOwners(throwingSend.deps, {
      kind: "daily_summary",
      dedupeKey: "d",
      recipients: owners.slice(0, 1),
      message,
    });
    expect(report.failed).toBe(1);
    expect(throwingSend.recorded[0].result).toEqual({
      ok: false,
      error: "socket hang up",
    });
  });

  it("builds keys Resend accepts", () => {
    const key = idempotencyKey(
      "card_payments_disabled",
      "acct_1UEb8nAPmYtojouJ:evt_1QwertyuiopASDFGHJKLzxcv",
      "00000000-0000-0000-0000-000000000000",
    );
    expect(key.length).toBeLessThanOrEqual(256);
  });
});

describe("the restaurant's own calendar", () => {
  // 2026-09-29 03:30 UTC: still the 28th in New York, already the 29th in
  // Kolkata.
  const now = new Date("2026-09-29T03:30:00Z");

  it("finds today and yesterday in the restaurant's timezone", () => {
    expect(localDate(now, "America/New_York")).toBe("2026-09-28");
    expect(localYesterday(now, "America/New_York")).toBe("2026-09-27");
    expect(localDate(now, "Asia/Kolkata")).toBe("2026-09-29");
    expect(localYesterday(now, "Asia/Kolkata")).toBe("2026-09-28");
  });

  it("crosses a month and a year", () => {
    expect(localYesterday(new Date("2026-10-01T15:00:00Z"), "UTC")).toBe(
      "2026-09-30",
    );
    expect(localYesterday(new Date("2027-01-01T15:00:00Z"), "UTC")).toBe(
      "2026-12-31",
    );
  });

  it("gets the day after daylight saving ends right", () => {
    // US clocks go back on 2026-11-01. At 13:00 UTC on the 2nd it is 8am
    // in New York, and yesterday is the 1st — a 25-hour day.
    expect(
      localYesterday(new Date("2026-11-02T13:00:00Z"), "America/New_York"),
    ).toBe("2026-11-01");
  });

  it("labels a day without the server's timezone shifting it", () => {
    expect(dayLabel("2026-09-28")).toBe("Monday, September 28");
    expect(dayLabel("2026-12-31")).toBe("Thursday, December 31");
  });
});

describe("the Resend call", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the message with the idempotency key and returns the id", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ id: "re_123" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendWithResend({
      apiKey: "re_test",
      from: "Tableside <hello@mail.tableside.menu>",
      to: "owner@example.com",
      message: { subject: "Hi", html: "<p>Hi</p>", text: "Hi" },
      idempotencyKey: "daily_summary:2026-09-28:u1",
    });

    expect(result).toEqual({ ok: true, id: "re_123" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_test");
    expect(headers["Idempotency-Key"]).toBe("daily_summary:2026-09-28:u1");
    expect(JSON.parse(init.body as string)).toEqual({
      from: "Tableside <hello@mail.tableside.menu>",
      to: ["owner@example.com"],
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
  });

  it("turns an error response into a result, not a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { message: "The mail.tableside.menu domain is not verified." },
          { status: 403 },
        ),
      ),
    );
    await expect(
      sendWithResend({
        apiKey: "k",
        from: "f",
        to: "t@example.com",
        message: { subject: "s", html: "h", text: "t" },
        idempotencyKey: "k",
      }),
    ).resolves.toEqual({
      ok: false,
      error: "resend 403: The mail.tableside.menu domain is not verified.",
    });
  });

  it("turns a network failure into a result, not a throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await sendWithResend({
      apiKey: "k",
      from: "f",
      to: "t@example.com",
      message: { subject: "s", html: "h", text: "t" },
      idempotencyKey: "k",
    });
    expect(result).toEqual({ ok: false, error: "network: fetch failed" });
  });
});

describe("the cron route's secret", () => {
  it("accepts only the exact bearer token", () => {
    expect(isAuthorizedCronRequest("Bearer s3cret", "s3cret")).toBe(true);
    expect(isAuthorizedCronRequest("Bearer wrong", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest("s3cret", "s3cret")).toBe(false);
    expect(isAuthorizedCronRequest(null, "s3cret")).toBe(false);
  });

  it("refuses everyone when no secret is configured", () => {
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer undefined", undefined)).toBe(false);
  });
});

describe("the boundary around the service-role sender", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory()
        ? sourceFiles(full)
        : /\.(ts|tsx)$/.test(name)
          ? [full]
          : [];
    });
  }

  it("is never a server action, so no browser can call it", () => {
    const source = readFileSync(
      path.resolve("src/lib/email/dispatch.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*["']use server["']/m);
    expect(source).toMatch(/import "server-only"/);
  });

  it("is imported only by the cron route and the two Stripe webhooks", () => {
    // Each is authenticated before it gets here — the cron route by
    // CRON_SECRET, the webhooks by Stripe's signature. A new importer is a
    // new way to reach the admin client.
    const importers = sourceFiles(path.resolve("src"))
      .filter((file) =>
        /from ["']@\/lib\/email\/dispatch["']/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(importers).toEqual([
      "src/app/api/cron/daily-summary/route.ts",
      "src/app/api/webhooks/stripe/platform/route.ts",
      "src/app/api/webhooks/stripe/route.ts",
    ]);
  });

  it("the cron route checks the secret before doing anything", () => {
    const source = readFileSync(
      path.resolve("src/app/api/cron/daily-summary/route.ts"),
      "utf8",
    );
    expect(source.indexOf("isAuthorizedCronRequest(")).toBeLessThan(
      source.indexOf("runDailySummaries()"),
    );
  });

  it("is scheduled once a day, which the Hobby plan allows", () => {
    const config = JSON.parse(
      readFileSync(path.resolve("vercel.json"), "utf8"),
    );
    expect(config.crons).toEqual([
      { path: "/api/cron/daily-summary", schedule: "0 13 * * *" },
    ]);
  });
});
