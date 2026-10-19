/**
 * What one AI use cost (docs/admin.md, Phase 4): tokens and cost read
 * from OpenRouter's replies and added up across the calls one use makes
 * (a waiter turn with tool calls makes several). Pure, so it is
 * unit-tested; usage.ts writes the result to ai_usage.
 *
 * OpenRouter reports the cost itself when asked (`usage: { include:
 * true }` on the request). When a reply doesn't, the tokens are priced
 * from the model's listed price and the row is marked estimated; when
 * even that isn't known, the cost stays null rather than 0.
 */

/** Ask every OpenRouter request for its cost. */
export const USAGE_REQUEST = { usage: { include: true } } as const;

export interface CallUsage {
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

function count(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n) && n >= 0
    ? n
    : null;
}

/** The `usage` block of an OpenRouter chat reply. Null when there is none. */
export function readUsage(body: unknown): CallUsage | null {
  const u = (body as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    tokensIn: count(u.prompt_tokens),
    tokensOut: count(u.completion_tokens),
    costUsd: count(u.cost),
  };
}

export interface UsageTally {
  calls: number;
  /** The model that answered last. */
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  /** Sum of the costs OpenRouter reported. */
  reportedUsd: number;
  /** Tokens of calls that came back without a cost, priced later from the list. */
  unpricedIn: number;
  unpricedOut: number;
  /** Calls with no usage block at all: neither tokens nor cost known. */
  unknownCalls: number;
}

export function newTally(): UsageTally {
  return {
    calls: 0,
    model: null,
    tokensIn: 0,
    tokensOut: 0,
    reportedUsd: 0,
    unpricedIn: 0,
    unpricedOut: 0,
    unknownCalls: 0,
  };
}

/** Adds one model call's reply to the tally. */
export function addCall(
  tally: UsageTally,
  body: unknown,
  model?: string | null,
): void {
  tally.calls += 1;
  if (model) tally.model = model;
  const usage = readUsage(body);
  if (!usage) {
    tally.unknownCalls += 1;
    return;
  }
  tally.tokensIn += usage.tokensIn ?? 0;
  tally.tokensOut += usage.tokensOut ?? 0;
  if (usage.costUsd !== null) {
    tally.reportedUsd += usage.costUsd;
  } else {
    tally.unpricedIn += usage.tokensIn ?? 0;
    tally.unpricedOut += usage.tokensOut ?? 0;
  }
}

/** Per-token prices in US dollars, as OpenRouter's model list gives them. */
export interface TokenPrice {
  promptPrice: number;
  completionPrice: number;
}

/**
 * The tally's cost: what OpenRouter reported, plus the listed price for
 * calls it didn't price. Null when part of it can't be known.
 */
export function tallyCost(
  tally: UsageTally,
  price: TokenPrice | null,
): { costUsd: number | null; estimated: boolean } {
  if (tally.unknownCalls > 0) return { costUsd: null, estimated: false };
  const unpriced = tally.unpricedIn + tally.unpricedOut > 0;
  if (!unpriced) return { costUsd: tally.reportedUsd, estimated: false };
  if (!price) return { costUsd: null, estimated: false };
  return {
    costUsd:
      tally.reportedUsd +
      tally.unpricedIn * price.promptPrice +
      tally.unpricedOut * price.completionPrice,
    estimated: true,
  };
}
