/**
 * Uploads server source maps to Sentry after a production build.
 *
 * WHY THIS EXISTS
 *
 * A production stack trace currently reads:
 *
 *   .next/server/chunks/_08the3w._.js, line 2, in a
 *
 * Everything is minified onto one line. That is survivable when the
 * message is Stripe's own and self-explanatory; it is not survivable for
 * payments.refund.attach, where money has left the restaurant's account
 * and the database does not know it. That trace would say `in iF` and
 * nothing more.
 *
 * WHY ONLY .next/server
 *
 * Browser source maps are off (productionBrowserSourceMaps is unset), so
 * the build emits none for the client — verified: 0 in .next/static, 274
 * in .next/server. Server maps are never served to a browser, so
 * uploading them exposes no source publicly. Pointing this at .next as a
 * whole would work too, and would start leaking the moment someone turns
 * browser maps on. Narrow on purpose.
 *
 * `inject` writes a debug id into each built file and its map, which is
 * how Sentry pairs them without relying on file paths — the paths differ
 * between build and /var/task at runtime.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  resolveUploadPlan,
  shouldFailBuildOnError,
} from "../src/lib/observability/sourcemap-upload";

const BUILD_DIR = ".next/server";

function run(args: string[]): number {
  const result = spawnSync("npx", ["sentry-cli", ...args], {
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

function main(): void {
  const plan = resolveUploadPlan(process.env);

  if (!plan.upload) {
    // Not an error. Said out loud so a missing upload is never a mystery.
    console.log(`[sourcemaps] skipped — ${plan.reason}`);
    return;
  }

  if (!existsSync(BUILD_DIR)) {
    console.log(`[sourcemaps] skipped — ${BUILD_DIR} does not exist.`);
    return;
  }

  console.log(
    `[sourcemaps] uploading ${BUILD_DIR} for release ${plan.release}`,
  );

  const injected = run(["sourcemaps", "inject", BUILD_DIR]);
  const uploaded =
    injected === 0
      ? run([
          "sourcemaps",
          "upload",
          BUILD_DIR,
          "--release",
          plan.release,
          "--org",
          plan.org,
          "--project",
          plan.project,
        ])
      : injected;

  if (uploaded === 0) {
    console.log("[sourcemaps] done");
    return;
  }

  // Same rule the reporter itself follows: monitoring must never break the
  // thing it observes, so a Sentry outage does not block a deploy. Loud,
  // but not fatal unless explicitly asked.
  console.error(
    `[sourcemaps] FAILED (exit ${uploaded}). Traces for this release will be minified.`,
  );
  if (shouldFailBuildOnError(process.env)) {
    process.exitCode = uploaded;
  }
}

main();
