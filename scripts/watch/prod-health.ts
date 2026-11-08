/**
 * The nightly watch's production check (agents/nightly-watch.md): a few
 * read-only GET requests to the live site, printed as Markdown. Exits 1 if
 * any check fails.
 *
 *   npm run watch:health
 *
 * Read-only on purpose. Nothing here signs in, scans a table QR (that
 * would create a real diner session), places an order or writes anything.
 * The old domain is checked because printed QR codes and Stripe webhooks
 * still point at it and don't follow redirects.
 */

interface Check {
  name: string;
  url: string;
  /** Status codes that count as healthy. */
  ok: number[];
  /** Extra test on a JSON body. */
  json?: (body: Record<string, unknown>) => string | null;
}

const SITE = process.env.WATCH_SITE ?? "https://tableside.menu";
const OLD_SITE =
  process.env.WATCH_OLD_SITE ?? "https://order.beacondigitalconsulting.org";
/** Slow enough that a guest would notice. */
const SLOW_MS = 4000;

const checks: Check[] = [
  {
    name: "Health endpoint",
    url: `${SITE}/api/health`,
    ok: [200],
    json: (b) => {
      if (b.status !== "ok") return `status is ${String(b.status)}`;
      const off = ["supabaseConfigured", "aiConfigured"].filter(
        (k) => b[k] !== true,
      );
      return off.length ? `not configured: ${off.join(", ")}` : null;
    },
  },
  { name: "Home page", url: `${SITE}/`, ok: [200] },
  { name: "Sign-in page", url: `${SITE}/login`, ok: [200] },
  { name: "Sitemap", url: `${SITE}/sitemap.xml`, ok: [200] },
  // Serves, not redirects: printed QR codes and webhooks depend on it.
  {
    // Its pages redirect to tableside.menu since 2026-11-08; its /api/
    // addresses keep answering for machines (src/lib/domains/core.ts).
    name: "Old domain's API still answering",
    url: `${OLD_SITE}/api/health`,
    ok: [200],
  },
];

async function runCheck(check: Check) {
  const started = Date.now();
  try {
    const response = await fetch(check.url, {
      redirect: "manual",
      headers: { "user-agent": "tableside-nightly-watch" },
      signal: AbortSignal.timeout(15_000),
    });
    const ms = Date.now() - started;
    if (!check.ok.includes(response.status)) {
      return { check, ms, problem: `HTTP ${response.status}` };
    }
    if (check.json) {
      const problem = check.json(
        (await response.json()) as Record<string, unknown>,
      );
      if (problem) return { check, ms, problem };
    }
    return { check, ms, problem: null, slow: ms > SLOW_MS };
  } catch (e) {
    return {
      check,
      ms: Date.now() - started,
      problem: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main() {
  const results = await Promise.all(checks.map(runCheck));
  console.info("### Production checks\n");
  for (const r of results) {
    // Slow is worth a mention, not an alarm: one slow cold start is normal.
    const verdict = r.problem ? "FAIL" : "slow" in r && r.slow ? "slow" : "ok";
    console.info(
      `- ${verdict} ${r.check.name} (${r.ms} ms)${r.problem ? `: ${r.problem}` : ""}`,
    );
  }
  process.exit(results.some((r) => r.problem) ? 1 : 0);
}

void main();
