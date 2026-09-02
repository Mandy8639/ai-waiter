/**
 * Whether a build should upload source maps, and to where.
 *
 * Pure and free of `server-only` so it can be tested directly — the same
 * extract-the-core convention as src/lib/payments/tip.ts. The script that
 * runs it (scripts/upload-sourcemaps.ts) is thin glue around this.
 *
 * WHY THIS IS A DECISION RATHER THAN A COMMAND
 *
 * Most builds must NOT upload: a local `npm run build`, CI, and a fork's
 * pull request all lack the credentials and should say so plainly rather
 * than failing. The interesting part is therefore the refusal, and the
 * reason attached to it, which is what makes a silent no-op debuggable
 * six months from now.
 */

export type UploadPlan =
  | { upload: true; release: string; org: string; project: string }
  | { upload: false; reason: string };

/**
 * The release MUST match what initMonitoring() sets on the SDK
 * (`VERCEL_GIT_COMMIT_SHA`). Sentry matches an incoming event's release
 * against the uploaded artifacts, so a mismatch here does not fail — it
 * silently produces exactly the minified traces this exists to fix.
 */
export function resolveUploadPlan(
  env: Record<string, string | undefined>,
): UploadPlan {
  const token = env.SENTRY_AUTH_TOKEN?.trim();
  const org = env.SENTRY_ORG?.trim();
  const project = env.SENTRY_PROJECT?.trim();
  const release = env.VERCEL_GIT_COMMIT_SHA?.trim();

  if (!token) {
    return {
      upload: false,
      reason:
        "SENTRY_AUTH_TOKEN is not set — expected on a local build, CI, or a fork's pull request.",
    };
  }
  if (!org || !project) {
    return {
      upload: false,
      reason:
        "SENTRY_ORG and SENTRY_PROJECT must both be set to know where to upload.",
    };
  }
  if (!release) {
    // Uploading without one would put artifacts under a release no event
    // ever reports, which looks like success and changes nothing.
    return {
      upload: false,
      reason:
        "VERCEL_GIT_COMMIT_SHA is not set, so there is no release to attach artifacts to.",
    };
  }

  return { upload: true, release, org, project };
}

/**
 * Whether a failed upload should fail the build.
 *
 * Default false, matching the rule the reporter itself follows: monitoring
 * must never break the thing it observes, and a Sentry outage should not
 * stop a deploy. Opt in with SENTRY_SOURCEMAPS_STRICT=1 where a silent
 * degradation would matter more than a blocked deploy.
 */
export function shouldFailBuildOnError(
  env: Record<string, string | undefined>,
): boolean {
  return env.SENTRY_SOURCEMAPS_STRICT === "1";
}
