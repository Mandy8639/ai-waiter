import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked locally rather than aliased in vitest.config.mts: the alias would
// apply to every test, and `server-only` failing loudly is a useful signal
// everywhere else.
vi.mock("server-only", () => ({}));

const captureException = vi.fn();
const flush = vi.fn(async (_timeout?: number) => true);
vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  captureException: (...args: unknown[]) => captureException(...args),
  // Typed to Sentry.flush's real signature rather than a spread of
  // unknown[], which does not satisfy it.
  flush: (timeout?: number) => flush(timeout),
}));

// after() throws outside a request, which is the situation every unit test
// is in — so these exercise the fallback path deliberately, the same one a
// non-request caller hits in production.
vi.mock("next/server", () => ({
  after: () => {
    throw new Error("after() called outside a request");
  },
}));

const { reportError, isMonitoringConfigured, flushMonitoring } =
  await import("@/lib/observability/report");

/**
 * The first rule of this module: reporting must never be able to break the
 * thing it observes. These calls sit directly in the payment paths, so a
 * throw here would turn a Stripe hiccup into a failed checkout.
 */

describe("reportError", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captureException.mockReset();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.SENTRY_DSN;
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete process.env.SENTRY_DSN;
  });

  it("logs even with no DSN, so a failure survives in platform logs", () => {
    reportError(new Error("boom"), { scope: "payments.test" });

    expect(consoleError).toHaveBeenCalledOnce();
    const logged = JSON.parse(consoleError.mock.calls[0][0] as string);
    expect(logged.scope).toBe("payments.test");
    expect(logged.message).toBe("boom");
    expect(logged.level).toBe("error");
  });

  it("does not reach for Sentry when unconfigured", () => {
    reportError(new Error("boom"), { scope: "payments.test" });
    expect(captureException).not.toHaveBeenCalled();
  });

  it("sends to Sentry with the scope as a tag once configured", () => {
    process.env.SENTRY_DSN = "https://key@example.test/1";

    reportError(new Error("boom"), {
      scope: "payments.refund.stripe",
      extra: { paymentId: "pay_1" },
    });

    expect(captureException).toHaveBeenCalledOnce();
    const [error, options] = captureException.mock.calls[0] as [
      Error,
      { tags: Record<string, string>; extra: Record<string, unknown> },
    ];
    expect(error.message).toBe("boom");
    expect(options.tags.scope).toBe("payments.refund.stripe");
    expect(options.extra.paymentId).toBe("pay_1");
  });

  it("does not throw when Sentry itself throws", () => {
    // A vendor outage must not take payments down with it.
    process.env.SENTRY_DSN = "https://key@example.test/1";
    captureException.mockImplementation(() => {
      throw new Error("sentry is down");
    });

    expect(() =>
      reportError(new Error("boom"), { scope: "payments.test" }),
    ).not.toThrow();
  });

  it("does not throw on a value that cannot be serialised", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      reportError(new Error("boom"), {
        scope: "payments.test",
        extra: circular as never,
      }),
    ).not.toThrow();
  });

  it("does not throw on a non-Error, which is what a database hands back", () => {
    expect(() =>
      reportError(
        { message: "no where clause", code: "21000" },
        {
          scope: "payments.tab.start",
        },
      ),
    ).not.toThrow();

    const logged = JSON.parse(consoleError.mock.calls[0][0] as string);
    expect(logged.name).toBe("PostgresError(21000)");
  });
});

describe("flushing on serverless", () => {
  /**
   * On Vercel a captured event is only queued; the runtime can freeze once
   * the response returns, so without a flush a report is captured
   * perfectly and never arrives.
   */
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captureException.mockReset();
    flush.mockReset();
    flush.mockImplementation(async () => true);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.SENTRY_DSN = "https://key@example.test/1";
  });

  afterEach(() => {
    consoleError.mockRestore();
    delete process.env.SENTRY_DSN;
  });

  it("flushes after capturing, so the event actually leaves", () => {
    reportError(new Error("boom"), { scope: "payments.test" });
    expect(flush).toHaveBeenCalled();
  });

  it("does not flush when there is no DSN, since nothing was queued", () => {
    delete process.env.SENTRY_DSN;
    reportError(new Error("boom"), { scope: "payments.test" });
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not throw when the flush itself fails", () => {
    flush.mockImplementation(async () => {
      throw new Error("network gone");
    });
    expect(() =>
      reportError(new Error("boom"), { scope: "payments.test" }),
    ).not.toThrow();
  });

  it("flushMonitoring awaits the queue, for callers already at the end", async () => {
    await flushMonitoring();
    expect(flush).toHaveBeenCalled();
  });

  it("flushMonitoring is inert and safe without a DSN", async () => {
    delete process.env.SENTRY_DSN;
    await expect(flushMonitoring()).resolves.toBeUndefined();
    expect(flush).not.toHaveBeenCalled();
  });
});

describe("isMonitoringConfigured", () => {
  afterEach(() => {
    delete process.env.SENTRY_DSN;
  });

  it("is false without a DSN, which is what local development wants", () => {
    delete process.env.SENTRY_DSN;
    expect(isMonitoringConfigured()).toBe(false);
  });

  it("is true with one", () => {
    process.env.SENTRY_DSN = "https://key@example.test/1";
    expect(isMonitoringConfigured()).toBe(true);
  });
});
