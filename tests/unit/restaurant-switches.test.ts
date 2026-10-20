import { describe, expect, it } from "vitest";
import {
  isRestaurantAiFeature,
  switchedOffMessage,
  switchedOffNotice,
  WAITER_OFF_FOR_DINERS,
} from "@/lib/admin/restaurant-switches-core";
import { SUPPORT_CONTACT_EMAIL } from "@/lib/legal/support";
import { readFileSync } from "node:fs";

/** Admin Phase 6: what a restaurant is told when Tableside switches an AI feature off. */

describe("restaurant AI switches", () => {
  it("knows its three features and nothing else", () => {
    for (const f of ["waiter", "staff_assistant", "owner_tools"]) {
      expect(isRestaurantAiFeature(f)).toBe(true);
    }
    expect(isRestaurantAiFeature("everything")).toBe(false);
  });

  it("tells the restaurant who switched it off and how to get it back", () => {
    const text = switchedOffMessage("staff_assistant");
    expect(text).toContain("switched off for this restaurant by Tableside");
    expect(text).toContain(SUPPORT_CONTACT_EMAIL);
  });

  it("tells diners only that the waiter isn't available", () => {
    expect(WAITER_OFF_FOR_DINERS).not.toMatch(/Tableside|owner|support/i);
  });

  it("puts every switched-off feature in one dashboard banner", () => {
    expect(switchedOffNotice(new Set())).toBeNull();
    const one = switchedOffNotice(new Set(["waiter"] as const))!;
    expect(one.title).toBe("Switched off by Tableside");
    expect(one.body).toMatch(/^AI waiter is switched off/);
    const two = switchedOffNotice(new Set(["owner_tools", "waiter"] as const))!;
    expect(two.body).toMatch(/^AI waiter and AI menu tools are switched off/);
    expect(two.body).toContain("turn them back on");
  });

  it("is checked by every AI entry point", () => {
    const checks: Array<[string, string]> = [
      ["src/lib/ai/actions.ts", '"waiter"'],
      ["src/lib/staff-assistant/actions.ts", '"staff_assistant"'],
      ["src/lib/menu-import/actions.ts", '"owner_tools"'],
      ["src/lib/menu-import/suggest-actions.ts", '"owner_tools"'],
      ["src/lib/nutrition/actions.ts", '"owner_tools"'],
      ["src/lib/translations/actions.ts", '"owner_tools"'],
    ];
    for (const [file, feature] of checks) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain(`isAiFeatureAllowed(`);
      expect(source, file).toContain(feature);
    }
    // Both staff assistant entry points, and both waiter gates.
    expect(
      readFileSync("src/lib/staff-assistant/actions.ts", "utf8").match(
        /isAiFeatureAllowed\(/g,
      ),
    ).toHaveLength(2);
    expect(
      readFileSync("src/lib/ai/actions.ts", "utf8").match(
        /isAiFeatureAllowed\(/g,
      ),
    ).toHaveLength(2);
  });
});
