/**
 * The owner-tunable persona (phase D): which tone the AI waiter uses, and a
 * short note in the owner's own words.
 *
 * No `server-only` import, so this is unit-testable and shared by the
 * settings form, the settings action and the system prompt. It holds the
 * two things that must agree across all three: the list of tones, and
 * what an owner's note is allowed to look like by the time it reaches a
 * prompt.
 *
 * WHAT A PERSONA CANNOT DO. It changes how the waiter sounds. It cannot
 * change what the waiter may state or do, and that is not a promise this
 * file makes — it is a property of where the real rules live. The menu-fact
 * guard decides from the customer's message alone whether a reply needs a
 * menu tool call (orchestrator.ts: `looksLikeMenuFactQuestion(trimmed)`);
 * the system prompt, and so this note, never reaches it. See
 * tests/unit/ai-persona-guard.test.ts.
 */

export const AI_TONES = ["warm", "formal", "playful", "concise"] as const;
export type AiTone = (typeof AI_TONES)[number];

export const DEFAULT_AI_TONE: AiTone = "warm";

/** Also enforced by restaurant_settings_ai_instructions_shape. */
export const AI_INSTRUCTIONS_MAX_LENGTH = 300;

export interface AiPersona {
  tone: AiTone;
  /** Already normalised — see normalizeAiInstructions. Null when unset. */
  instructions: string | null;
}

export const DEFAULT_AI_PERSONA: AiPersona = {
  tone: DEFAULT_AI_TONE,
  instructions: null,
};

export function isAiTone(value: unknown): value is AiTone {
  return (
    typeof value === "string" && (AI_TONES as readonly string[]).includes(value)
  );
}

/** What the owner picks from, in the settings form. */
export const AI_TONE_OPTIONS: ReadonlyArray<{
  value: AiTone;
  label: string;
  description: string;
}> = [
  {
    value: "warm",
    label: "Warm",
    description: "Friendly and natural, like a good waiter. The default.",
  },
  {
    value: "formal",
    label: "Formal",
    description: "Polished and courteous, for a fine-dining room.",
  },
  {
    value: "playful",
    label: "Playful",
    description: "Light and cheerful, with a little humour where it fits.",
  },
  {
    value: "concise",
    label: "Concise",
    description: "Short answers, straight to the point.",
  },
];

/**
 * What an owner's note looks like by the time it is stored or prompted.
 *
 * Each rule closes a specific way free text could stop being "a note" and
 * start being structure inside the prompt:
 *
 *   - Every run of whitespace, newlines included, becomes one space. The
 *     prompt is sectioned by `## ` headings at the start of a line; a note
 *     that can never contain a newline can never start a line, so it can
 *     never forge a heading such as "## Tool authorization".
 *   - Control characters are removed outright (the database refuses them
 *     too — restaurant_settings_ai_instructions_shape).
 *   - Double quotes of every kind become single quotes. The prompt wraps
 *     the note in double quotes to mark where the owner's words begin and
 *     end, and a note must not be able to close that quote early and carry
 *     on as if the prompt itself were speaking.
 *   - Capped at AI_INSTRUCTIONS_MAX_LENGTH, and empty becomes null so "no
 *     note" has exactly one representation.
 *
 * Deliberately NOT done: guessing at intent. There is no list of banned
 * phrases like "ignore previous instructions" — such a list is endless,
 * trivially paraphrased, and would give a false sense that it was doing
 * the work. The work is done by the guards, which do not read this text.
 */
export function normalizeAiInstructions(raw: unknown): string | null {
  const tidied = tidyAiInstructions(raw);
  if (tidied === null) return null;
  const capped = tidied.slice(0, AI_INSTRUCTIONS_MAX_LENGTH).trim();
  return capped.length > 0 ? capped : null;
}

/**
 * Everything normalizeAiInstructions does EXCEPT the length cap. The
 * settings form's validation and its character counter use this, so an
 * over-long note is refused with a message the owner can act on — rather
 * than silently cut to 300 characters mid-sentence. Only the prompt caps.
 */
export function tidyAiInstructions(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .replace(/["\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, "'")
    .trim();

  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The persona as the AI reads it, from whatever the database returned.
 * Anything unexpected falls back to the default voice rather than failing
 * the turn: a persona is cosmetic, and a diner should never lose the
 * waiter because a style setting could not be read.
 */
export function toAiPersona(row: unknown): AiPersona {
  const record = (row ?? {}) as { tone?: unknown; instructions?: unknown };
  return {
    tone: isAiTone(record.tone) ? record.tone : DEFAULT_AI_TONE,
    instructions: normalizeAiInstructions(record.instructions),
  };
}
