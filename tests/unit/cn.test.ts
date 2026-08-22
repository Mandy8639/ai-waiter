import { describe, expect, it } from "vitest";
import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("flex", "items-center")).toBe("flex items-center");
  });

  it("drops falsy values", () => {
    expect(cn("flex", false && "hidden", undefined, "gap-2")).toBe(
      "flex gap-2",
    );
  });

  it("resolves conflicting Tailwind classes to the last one", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
  });
});
