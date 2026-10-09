import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every Chef motion must sit inside the reduced-motion guard, so it never
 * animates for someone who asked their device for less motion. The global
 * reduced-motion rule is a second line; this keeps the first one honest.
 */
describe("Chef motion CSS", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("only attaches animations to chef-motion classes inside prefers-reduced-motion: no-preference", () => {
    const guardStart = css.indexOf(
      "@media (prefers-reduced-motion: no-preference)",
    );
    expect(guardStart).toBeGreaterThan(-1);
    // The guarded block: from the @media line to its matching brace.
    let depth = 0;
    let guardEnd = -1;
    for (let i = css.indexOf("{", guardStart); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
      if (depth === 0) {
        guardEnd = i;
        break;
      }
    }
    const inside = css.slice(guardStart, guardEnd);
    const outside = css.slice(0, guardStart) + css.slice(guardEnd);

    for (const motion of ["wave", "think", "nod"]) {
      expect(inside).toContain(`.chef-motion-${motion}`);
      expect(outside).not.toContain(`.chef-motion-${motion}`);
    }
  });
});
