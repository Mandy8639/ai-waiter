import { describe, expect, it } from "vitest";
import {
  resolveUploadPlan,
  shouldFailBuildOnError,
} from "@/lib/observability/sourcemap-upload";

const complete = {
  SENTRY_AUTH_TOKEN: "tok",
  SENTRY_ORG: "beacon-digital",
  SENTRY_PROJECT: "ai-waiter",
  VERCEL_GIT_COMMIT_SHA: "abc123",
};

/**
 * Most builds must NOT upload, so the refusals are the interesting part —
 * and each carries a reason, because a silent no-op is what makes an
 * absent upload a mystery months later.
 */

describe("resolveUploadPlan", () => {
  it("uploads when everything is present", () => {
    expect(resolveUploadPlan(complete)).toEqual({
      upload: true,
      release: "abc123",
      org: "beacon-digital",
      project: "ai-waiter",
    });
  });

  it("skips without a token — a local build or a fork's PR", () => {
    const plan = resolveUploadPlan({
      ...complete,
      SENTRY_AUTH_TOKEN: undefined,
    });
    expect(plan.upload).toBe(false);
    if (!plan.upload) expect(plan.reason).toMatch(/SENTRY_AUTH_TOKEN/);
  });

  it("skips when org or project is missing", () => {
    expect(
      resolveUploadPlan({ ...complete, SENTRY_ORG: undefined }).upload,
    ).toBe(false);
    expect(
      resolveUploadPlan({ ...complete, SENTRY_PROJECT: undefined }).upload,
    ).toBe(false);
  });

  it("skips without a release rather than uploading to nowhere", () => {
    // Artifacts under a release no event reports look like success and
    // change nothing — the worst kind of failure for this feature.
    const plan = resolveUploadPlan({
      ...complete,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    expect(plan.upload).toBe(false);
    if (!plan.upload) expect(plan.reason).toMatch(/release/i);
  });

  it("treats blank and whitespace-only values as absent", () => {
    expect(
      resolveUploadPlan({ ...complete, SENTRY_AUTH_TOKEN: "  " }).upload,
    ).toBe(false);
    expect(
      resolveUploadPlan({ ...complete, VERCEL_GIT_COMMIT_SHA: "" }).upload,
    ).toBe(false);
  });

  it("trims, so a stray newline in a dashboard-pasted value still works", () => {
    const plan = resolveUploadPlan({
      ...complete,
      VERCEL_GIT_COMMIT_SHA: "abc123\n",
    });
    expect(plan.upload).toBe(true);
    if (plan.upload) expect(plan.release).toBe("abc123");
  });

  it("gives every refusal a reason", () => {
    for (const key of [
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
      "SENTRY_PROJECT",
      "VERCEL_GIT_COMMIT_SHA",
    ]) {
      const plan = resolveUploadPlan({ ...complete, [key]: undefined });
      expect(plan.upload).toBe(false);
      if (!plan.upload) expect(plan.reason.length).toBeGreaterThan(10);
    }
  });
});

describe("shouldFailBuildOnError", () => {
  it("does not fail a build by default", () => {
    // Same rule the reporter follows: monitoring must never break the
    // thing it observes, and a Sentry outage should not block a deploy.
    expect(shouldFailBuildOnError({})).toBe(false);
  });

  it("fails only on an explicit opt-in", () => {
    expect(shouldFailBuildOnError({ SENTRY_SOURCEMAPS_STRICT: "1" })).toBe(
      true,
    );
    expect(shouldFailBuildOnError({ SENTRY_SOURCEMAPS_STRICT: "true" })).toBe(
      false,
    );
  });
});
