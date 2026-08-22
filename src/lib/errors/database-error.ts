import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Maps a raw Postgres/PostgREST error into a message safe to show a user —
 * never the original `error.message` (which can include table/constraint
 * names, SQL fragments, or other internal detail).
 *
 * `entityLabel` is a lowercase singular noun for the thing being acted on
 * ("menu item", "category", "table", ...), used to make the message
 * concrete rather than generic.
 */
export function toFriendlyError(
  error: PostgrestError,
  entityLabel: string,
): string {
  switch (error.code) {
    case "23505": // unique_violation
      return `Another ${entityLabel} already uses that value — try something else.`;
    case "23503": // foreign_key_violation
      return `That ${entityLabel} couldn't be deleted because it still has associated data.`;
    case "23514": // check_violation
      return `One of the values you entered isn't valid for that ${entityLabel}.`;
    case "42501": // insufficient_privilege
      return "You don't have permission to perform this action.";
    default:
      if (error.message.toLowerCase().includes("row-level security")) {
        return "You don't have permission to perform this action.";
      }
      return "Something went wrong. Please try again.";
  }
}
