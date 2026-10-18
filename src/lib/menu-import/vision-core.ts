import {
  draftsFromCategories,
  readExtraction,
  type ExtractionResult,
  type ParseOutcome,
} from "./extraction";

/**
 * Reading menu photos: one request per photo, all at once, each retried
 * on a different model first if it fails, then merged in photo order.
 * The network call is passed in, so this is unit-tested without one
 * (tests/unit/menu-import-vision.test.ts). No `server-only`.
 *
 * Why per photo (found 2026-10-18, a real two-photo import failing with
 * "Couldn't read a menu from that response"):
 *
 *   - The free vision models think before they answer, and the thinking
 *     counts against the same output allowance. A dense two-page menu in
 *     one request used 7,984 of 8,000 tokens in testing; real photos ran
 *     out, the JSON was cut off mid-way, and nothing was readable. One
 *     photo per request halves the answer, and the allowance is larger.
 *   - A busy model can come back as HTTP 200 with an error in the body
 *     and no reply at all ("ResourceExhausted"), which used to read as an
 *     unreadable menu. It now counts as a failure and is retried.
 *   - One bad page no longer costs the others a model: each page retries
 *     on its own.
 */

/** What one model call came back with. */
export interface VisionReply {
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  content: string;
  /** "stop", or "length" when the reply was cut off. */
  finishReason?: string | null;
  /** The model that actually answered. */
  servedModel?: string;
  /** An error carried in the body, even under a 200. */
  bodyError?: string;
  timedOut?: boolean;
}

export type CallVisionModel = (
  imageDataUrl: string,
  models: string[],
) => Promise<VisionReply>;

export interface PagesOutcome extends ParseOutcome {
  model?: string;
}

/** Tries per photo: the preference list, then once more starting from the next model. */
export const ATTEMPTS_PER_PAGE = 2;

/** The list with a different model first, so a retry doesn't hit the one that just failed. */
export function rotate<T>(list: T[], by: number): T[] {
  if (list.length === 0) return list;
  const n = by % list.length;
  return [...list.slice(n), ...list.slice(0, n)];
}

type PageResult =
  | { ok: true; categories: ExtractionResult["categories"]; model?: string }
  | { ok: false; error: string; busy: boolean; timedOut: boolean };

/** Why a reply can't be used, or its categories. */
export function readReply(reply: VisionReply): PageResult {
  if (reply.timedOut) {
    return { ok: false, error: "timed out", busy: false, timedOut: true };
  }
  if (reply.status === 429) {
    return { ok: false, error: "rate limited", busy: true, timedOut: false };
  }
  if (reply.status !== 200) {
    return {
      ok: false,
      error: `HTTP ${reply.status}`,
      busy: reply.status >= 500,
      timedOut: false,
    };
  }
  if (reply.bodyError || !reply.content.trim()) {
    return {
      ok: false,
      error: reply.bodyError ?? "empty reply",
      busy: true,
      timedOut: false,
    };
  }
  const read = readExtraction(reply.content);
  if (!read.ok) {
    return {
      ok: false,
      error: reply.finishReason === "length" ? "reply cut off" : read.error,
      busy: false,
      timedOut: false,
    };
  }
  return { ok: true, categories: read.categories, model: reply.servedModel };
}

async function readPage(
  imageDataUrl: string,
  models: string[],
  call: CallVisionModel,
): Promise<PageResult> {
  let last: PageResult = {
    ok: false,
    error: "not tried",
    busy: false,
    timedOut: false,
  };
  for (let attempt = 0; attempt < ATTEMPTS_PER_PAGE; attempt += 1) {
    last = readReply(await call(imageDataUrl, rotate(models, attempt)));
    if (last.ok) return last;
  }
  return last;
}

function photoList(indexes: number[]): string {
  const names = indexes.map((i) => `photo ${i + 1}`);
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export async function extractPages(
  imageDataUrls: string[],
  models: string[],
  call: CallVisionModel,
): Promise<PagesOutcome> {
  const results = await Promise.all(
    imageDataUrls.map((url) => readPage(url, models, call)),
  );

  const failed = results.flatMap((r, i) => (r.ok ? [] : [i]));
  if (failed.length > 0) {
    const failures = failed.map((i) => results[i]) as Extract<
      PageResult,
      { ok: false }
    >[];
    const which = imageDataUrls.length === 1 ? "that photo" : photoList(failed);
    const error = failures.every((f) => f.timedOut)
      ? `Reading ${which} took too long. Try again, or a smaller photo.`
      : failures.every((f) => f.busy)
        ? "The menu reader is busy right now. Please try again in a minute."
        : `Couldn't read ${which}. Try again, or retake it closer and straight on, in good light.`;
    return { ok: false, drafts: [], unpricedCount: 0, error };
  }

  const ok = results as Extract<PageResult, { ok: true }>[];
  const outcome = draftsFromCategories(ok.flatMap((r) => r.categories));
  // The models that answered, for the import row: usually one.
  const served = [...new Set(ok.map((r) => r.model).filter(Boolean))];
  return { ...outcome, model: served.join(", ") || undefined };
}
