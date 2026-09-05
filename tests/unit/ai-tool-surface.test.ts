import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Static-analysis check on the AI tool source files, not an import-based
 * one — src/lib/ai/tools/*.ts all have `import "server-only"` (they touch
 * Supabase), which throws unconditionally outside Next.js's RSC bundling
 * and therefore can't be imported directly in Vitest (see
 * src/lib/env-helpers.ts's header comment for the full explanation).
 * Reading the files as text is the right tool for this specific
 * guarantee anyway: spec section 4 is explicit that no
 * execute_sql/query_database/admin_supabase/arbitrary_rpc/generic_mutation
 * tool may exist, ever — a structural fact about the source, not
 * something that needs a running server to check.
 */
const TOOL_FILES = ["menu.ts", "cart.ts", "order.ts", "index.ts"];
const TOOLS_DIR = resolve(__dirname, "../../src/lib/ai/tools");

const FORBIDDEN_TOOL_NAMES = [
  "execute_sql",
  "query_database",
  "admin_supabase",
  "arbitrary_rpc",
  "generic_mutation",
];

/** Strips /* *\/ and // comments so substring checks below can't false-positive on explanatory prose (e.g. this file's own doc comments naming the forbidden tools as examples). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readToolSource(file: string): string {
  return stripComments(readFileSync(resolve(TOOLS_DIR, file), "utf8"));
}

describe("AI tool surface (spec section 4)", () => {
  it("contains none of the explicitly forbidden generic/admin tool names anywhere in the tools directory", () => {
    for (const file of TOOL_FILES) {
      const source = readToolSource(file);
      for (const forbidden of FORBIDDEN_TOOL_NAMES) {
        expect(
          source.includes(forbidden),
          `${file} must not mention "${forbidden}"`,
        ).toBe(false);
      }
    }
  });

  it("never imports the admin/service-role Supabase client", () => {
    for (const file of TOOL_FILES) {
      const source = readToolSource(file);
      expect(
        source.includes("supabase/admin") ||
          source.includes("createAdminClient"),
        `${file} must never use the admin client — see docs/security.md#ai-tool-authorization`,
      ).toBe(false);
    }
  });

  it("registers the expected, fixed set of tool names — nothing more", () => {
    const names = new Set<string>();
    for (const file of ["menu.ts", "cart.ts", "order.ts"]) {
      const source = readToolSource(file);
      for (const match of source.matchAll(/\bname:\s*"([a-z_]+)"/g)) {
        names.add(match[1]);
      }
    }

    expect([...names].sort()).toEqual(
      [
        "add_item_to_cart",
        "clear_cart",
        "get_cart",
        "get_customer_order_history",
        "get_menu_item",
        "get_order_status",
        "get_restaurant_info",
        "remove_cart_item",
        "request_order_confirmation",
        "search_menu",
        "submit_order",
        "update_cart_item",
      ].sort(),
    );
  });

  it("returns every kind of dish detail get_menu_item's description advertises", () => {
    // A real bug this catches: get_menu_item's description promised
    // ingredients for weeks while the query never selected them, so the
    // waiter answered "the menu doesn't provide that" about 726 recorded
    // ingredient links. The description is what the model plans against,
    // so a promise it doesn't keep is worse than a missing feature.
    const source = readToolSource("menu.ts");
    for (const [column, key] of [
      ["preparation_time", "preparationTimeMinutes"],
      ["portion_note", "portionNote"],
    ]) {
      expect(source, `menu.ts must select ${column}`).toContain(column);
      expect(source, `menu.ts must return ${key}`).toContain(`${key}:`);
    }
    expect(source).toContain("ingredients:");
    expect(source).toContain("declaredAllergens:");
    expect(source).toMatch(/portion size/);
  });

  it("no tool's execute function accepts a restaurantId/tableId/customerSessionId argument by name in its schema (context is always derived server-side, never a tool argument)", () => {
    const schemaSource = stripComments(
      readFileSync(resolve(TOOLS_DIR, "schemas.ts"), "utf8"),
    );
    for (const forbidden of [
      "restaurantId",
      "restaurant_id",
      "tableId",
      "table_id",
      "customerSessionId",
      "customer_session_id",
    ]) {
      expect(
        schemaSource.includes(forbidden),
        `schemas.ts must never define a ${forbidden} field`,
      ).toBe(false);
    }
  });
});
