import "server-only";
import { freeModelDraft } from "@/lib/ai/free-draft";
import { draftPrompt, parseDraftReply, type DraftField } from "./core";
import type { MenuLanguage } from "./languages";

export type DraftResult =
  | { ok: true; translations: Map<string, string> }
  | { ok: false; reason: "not_free" | "not_configured" | "failed" };

/**
 * Asks the free model for draft translations of one batch of fields
 * (phase K), retrying when the free router doesn't answer or answers with
 * nothing usable (src/lib/ai/free-draft-core.ts). Drafts only: nothing
 * here is shown to a diner until a person approves it.
 */
export async function draftTranslations(
  language: MenuLanguage,
  fields: DraftField[],
): Promise<DraftResult> {
  const { system, user } = draftPrompt(language, fields);
  const result = await freeModelDraft({
    system,
    user,
    maxTokens: 4000,
    parse: (reply) => parseDraftReply(reply, fields, language),
    usable: (translations) => translations.size > 0,
  });
  return result.ok ? { ok: true, translations: result.value } : result;
}
