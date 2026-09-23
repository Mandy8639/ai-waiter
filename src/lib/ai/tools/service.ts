import "server-only";
import type { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import {
  DINER_CONFIRMATIONS,
  requestErrorMessage,
  type RequestKind,
} from "@/lib/table-requests/core";
import { requestServiceSchema } from "./schemas";
import type { ToolContext, ToolDefinition, ToolResult } from "./types";

/**
 * Letting the waiter fetch a person.
 *
 * This is the tool that makes "can we get the bill?" work as a sentence
 * rather than as a button hunt. It is also the one tool in this file whose
 * side effect is a human being walking across a room, which is worth
 * saying out loud: every other tool changes a row, this one interrupts
 * somebody's work.
 *
 * That is why the description given to the model is narrow — ask only when
 * the customer actually asks for a person or for the bill — and why there
 * is no third kind. A model that could invent a reason to summon staff
 * would, eventually, on a slow Tuesday.
 *
 * THE SAME FUNCTION THE BUTTONS CALL. This goes through
 * create_table_request() exactly as the diner's own buttons do, so the
 * one-open-request-per-kind rule and the rolling cap apply identically.
 * There is no AI-specific path to staff attention, and asking twice in one
 * conversation returns the existing request rather than ringing twice.
 */

type RequestServiceArgs = z.infer<typeof requestServiceSchema>;

type UntypedRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message: string } | null }>;

async function createRequest(
  kind: RequestKind,
  note: string | undefined,
): Promise<ToolResult> {
  const supabase = await createClient();
  // database.types.ts predates this migration; see
  // src/lib/table-requests/actions.ts for the same note.
  const rpc = supabase.rpc.bind(supabase) as unknown as UntypedRpc;

  const { data, error } = await rpc("create_table_request", {
    p_kind: kind,
    p_note: note ?? null,
  });
  if (error) {
    return { ok: false, error: requestErrorMessage(error.message) };
  }

  return {
    ok: true,
    data: {
      requestId: data as string,
      kind,
      // The confirmation the diner's own buttons show, so the waiter says
      // the same thing the interface would have.
      confirmation: DINER_CONFIRMATIONS[kind],
    },
  };
}

export const serviceTools: ToolDefinition[] = [
  {
    name: "request_service",
    description:
      "Ask a member of staff to come to the customer's table, or to bring their bill. Use this only when the customer has actually asked for a person or for the bill — never to answer a question you could answer yourself, and never on your own initiative. Calling it twice for the same thing does not ask twice.",
    schema: requestServiceSchema,
    execute: async (args, _context: ToolContext): Promise<ToolResult> => {
      const { kind, note } = args as RequestServiceArgs;
      // `_context` is unused on purpose: create_table_request() derives the
      // restaurant and table from the caller's own session inside the
      // database, so there is nothing to pass and nothing to get wrong.
      return createRequest(kind, note);
    },
  },
];
