import { describe, expect, it } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import { toFriendlyError } from "@/lib/errors/database-error";

function error(code: string, message = "raw postgres detail"): PostgrestError {
  return {
    code,
    message,
    details: "",
    hint: "",
    name: "PostgrestError",
    toJSON() {
      return { code, message, details: "", hint: "", name: "PostgrestError" };
    },
  };
}

describe("toFriendlyError", () => {
  it("maps unique_violation to a friendly duplicate message", () => {
    expect(toFriendlyError(error("23505"), "table")).toMatch(/already uses/i);
  });

  it("maps foreign_key_violation to a friendly dependency message", () => {
    expect(toFriendlyError(error("23503"), "menu item")).toMatch(
      /associated data/i,
    );
  });

  it("maps check_violation to a friendly validation message", () => {
    expect(toFriendlyError(error("23514"), "category")).toMatch(/isn't valid/i);
  });

  it("maps insufficient_privilege to a permission message", () => {
    expect(toFriendlyError(error("42501"), "table")).toMatch(/permission/i);
  });

  it("detects row-level security violations by message even without a matching code", () => {
    expect(
      toFriendlyError(
        error("XX000", "new row violates row-level security policy"),
        "item",
      ),
    ).toMatch(/permission/i);
  });

  it("never leaks the raw Postgres message for unknown errors", () => {
    const friendly = toFriendlyError(
      error("99999", 'column "secret_internal_column" does not exist'),
      "item",
    );
    expect(friendly).not.toContain("secret_internal_column");
  });
});
