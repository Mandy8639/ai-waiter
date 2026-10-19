/**
 * The free safety net (docs/admin.md), for the waiter and the staff
 * assistant: which free models are checked each day for each job, which
 * of them the job may fall back to, and when it does. No `server-only` and no I/O, so every rule is unit-tested;
 * safety-net.ts reads the store and src/lib/admin/safety-net-check.ts
 * runs the daily check.
 *
 * Only models that passed the Admin page's waiter Test count, and only
 * when it is that or no answer at all: a passing Test is one good answer,
 * not a track record (see scripts/vet-models-by-job.ts), so the waiter's
 * own list is always tried first.
 */

import { AiProviderError, type AiErrorCategory } from "./provider-error";
import { OPENROUTER_MAX_MODELS } from "./model-list";

/** How long a pass counts for. A model that hasn't passed in three daily checks is dropped. */
export const PASS_VALID_MS = 3 * 24 * 60 * 60 * 1000;

/** The jobs with a safety net: the two that run live, during service. */
export const SAFETY_NET_JOBS = ["waiter", "staff_assistant"] as const;
export type SafetyNetJob = (typeof SAFETY_NET_JOBS)[number];

/** The platform_switches row that turns a job's net off. */
export function switchName(job: SafetyNetJob): string {
  return `${job}_safety_net`;
}

/** Most models checked per day: keeps the daily check inside its time limit and the free tier's request allowance. */
export const MAX_CANDIDATES = 12;

/** OpenRouter's "any free model" alias picks a different model each time, so no check can vouch for it. */
const NOT_A_MODEL = new Set(["openrouter/free"]);

/** Music, audio, embedding and safety-classifier models are not chat models. */
const NOT_A_GENERAL_MODEL = /lyria|content-safety|guard|whisper|tts|embed/i;

/**
 * Models that pass the one-off Test but have failed in real conversations
 * in this app (src/lib/ai/config.ts records each). A Test is one clean
 * question; these went wrong over a real, messier conversation, so they
 * are never checked and never used. Add to this list when another one
 * does.
 */
export const NEVER_USE: Readonly<
  Record<SafetyNetJob, Readonly<Record<string, string>>>
> = {
  waiter: {
    "nvidia/nemotron-3.5-lightning:free":
      "made no menu lookups and took 54 s in a real conversation",
    "nvidia/nemotron-3-ultra-550b-a55b:free":
      "answered menu questions without looking them up",
    "nvidia/nemotron-3-super-120b-a12b:free":
      "read its private reasoning and instructions out to a diner",
    "poolside/laguna-s-2.1:free": "made up a recommendation",
  },
  staff_assistant: {},
};

export function isFreeName(model: string): boolean {
  return model.endsWith(":free");
}

/**
 * Which free models the daily check tries for a job: free, plausibly a
 * chat model, and for the waiter able to call tools (the staff assistant
 * sends none; it reads one message and answers in JSON).
 */
export function safetyNetCandidates(
  models: Iterable<{ id: string; tools: boolean }>,
  job: SafetyNetJob,
): string[] {
  return [...models]
    .filter(
      (m) =>
        isFreeName(m.id) &&
        (m.tools || job !== "waiter") &&
        !NOT_A_MODEL.has(m.id) &&
        !NOT_A_GENERAL_MODEL.test(m.id) &&
        !(m.id in NEVER_USE[job]),
    )
    .map((m) => m.id)
    .sort()
    .slice(0, MAX_CANDIDATES);
}

export type CheckStatus = "passed" | "failed" | "busy";

export interface FreeModelCheck {
  job: SafetyNetJob;
  model: string;
  status: CheckStatus;
  lastPassedAt: string | null;
  passMs: number | null;
  checkedAt: string;
}

/** Whether a model may be used: it passed within three days, and its latest check didn't fail. */
export function isEligible(check: FreeModelCheck, now: Date): boolean {
  if (check.status === "failed" || !check.lastPassedAt) return false;
  if (!isFreeName(check.model) || check.model in NEVER_USE[check.job]) {
    return false;
  }
  return (
    now.getTime() - new Date(check.lastPassedAt).getTime() <= PASS_VALID_MS
  );
}

/**
 * The eligible models of one job's checks: first the ones this app has
 * vetted for that job (`preferred`, in its order), then the rest, fastest passing Test first.
 * Speed alone favours small models, and small models are where
 * conversation quality falls apart (src/lib/ai/config.ts), so it only
 * breaks ties among the unvetted.
 */
export function rankSafetyNet(
  checks: readonly FreeModelCheck[],
  now: Date,
  preferred: readonly string[] = [],
): string[] {
  const order = (model: string) => {
    const i = preferred.indexOf(model);
    return i === -1 ? preferred.length : i;
  };
  return checks
    .filter((c) => isEligible(c, now))
    .sort(
      (a, b) =>
        order(a.model) - order(b.model) ||
        (a.passMs ?? Number.MAX_SAFE_INTEGER) -
          (b.passMs ?? Number.MAX_SAFE_INTEGER) ||
        a.model.localeCompare(b.model),
    )
    .map((c) => c.model);
}

/**
 * What a new check result does to a model's row. Busy keeps the last
 * pass (a rate limit says the free tier is full, not that the model is
 * wrong); a failure keeps the date but makes the model ineligible until
 * it passes again.
 */
export function nextCheck(
  previous: FreeModelCheck | undefined,
  job: SafetyNetJob,
  model: string,
  outcome: { status: CheckStatus; ms: number },
  now: Date,
): FreeModelCheck {
  const passed = outcome.status === "passed";
  return {
    job,
    model,
    status: outcome.status,
    lastPassedAt: passed ? now.toISOString() : (previous?.lastPassedAt ?? null),
    passMs: passed ? outcome.ms : (previous?.passMs ?? null),
    checkedAt: now.toISOString(),
  };
}

/** Failures that mean "these models can't answer right now", where another model might. */
const RETRYABLE: ReadonlySet<AiErrorCategory> = new Set([
  "rate_limited",
  "http_error",
  "timeout",
]);

export function shouldUseSafetyNet(error: unknown): boolean {
  return error instanceof AiProviderError && RETRYABLE.has(error.category);
}

/**
 * One model call, with one more try on the safety net if the job's own
 * list couldn't answer. The net never repeats a model already tried,
 * and an empty net rethrows the original error.
 */
export async function callWithSafetyNet<T>(input: {
  primary: readonly string[];
  call: (models: string[]) => Promise<T>;
  safetyNet: () => Promise<string[]>;
  onUsed?: (models: string[], error: AiProviderError) => void;
}): Promise<T> {
  try {
    return await input.call([...input.primary]);
  } catch (error) {
    if (!shouldUseSafetyNet(error)) throw error;
    const tried = new Set(input.primary);
    const net = (await input.safetyNet())
      .filter((m) => !tried.has(m))
      .slice(0, OPENROUTER_MAX_MODELS);
    if (net.length === 0) throw error;
    input.onUsed?.(net, error as AiProviderError);
    return input.call(net);
  }
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function formatAgo(iso: string, now: Date): string {
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - new Date(iso).getTime()) / 60_000),
  );
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** The Admin page's list for one job's checks: the net in the order it is tried, then everything else checked. */
export function safetyNetRows(
  checks: readonly FreeModelCheck[],
  now: Date,
  preferred: readonly string[] = [],
) {
  const net = rankSafetyNet(checks, now, preferred);
  const rank = new Map(net.map((m, i) => [m, i + 1]));
  const seconds = (ms: number | null) =>
    ms === null ? "" : ` · ${(ms / 1000).toFixed(1)} s`;
  return [...checks]
    .sort(
      (a, b) =>
        (rank.get(a.model) ?? Infinity) - (rank.get(b.model) ?? Infinity) ||
        a.model.localeCompare(b.model),
    )
    .map((c) => {
      const inNet = rank.has(c.model);
      let detail: string;
      const never = NEVER_USE[c.job][c.model];
      if (never) {
        detail = `never used: ${never}`;
      } else if (inNet && c.status === "passed") {
        detail = `passed ${formatAgo(c.checkedAt, now)}${seconds(c.passMs)}`;
      } else if (inNet) {
        detail = `busy ${formatAgo(c.checkedAt, now)}, passed ${formatAgo(c.lastPassedAt!, now)}${seconds(c.passMs)}`;
      } else if (c.status === "busy") {
        detail = `busy ${formatAgo(c.checkedAt, now)}`;
      } else if (c.status === "passed") {
        detail = `last passed ${formatAgo(c.checkedAt, now)}, too long ago`;
      } else {
        detail = `failed ${formatAgo(c.checkedAt, now)}`;
      }
      return {
        model: c.model,
        rank: rank.get(c.model) ?? null,
        status: c.status,
        detail,
      };
    });
}

/** When the daily check last ran: the newest check of any model. */
export function lastCheckedAt(
  checks: readonly FreeModelCheck[],
): string | null {
  return checks.reduce<string | null>(
    (latest, c) =>
      latest === null || c.checkedAt > latest ? c.checkedAt : latest,
    null,
  );
}
