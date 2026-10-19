import { describe, expect, it } from "vitest";
import {
  isPlatformAdminEmail,
  parseAdminEmails,
} from "@/lib/admin/access-core";

describe("platform admin emails", () => {
  it("parses a comma-separated list, case-insensitively", () => {
    expect(parseAdminEmails(" Owner@Example.com, b@x.io ,, nope ")).toEqual([
      "owner@example.com",
      "b@x.io",
    ]);
    expect(parseAdminEmails(undefined)).toEqual([]);
  });

  it("lets in only listed emails", () => {
    const list = parseAdminEmails("owner@example.com");
    expect(isPlatformAdminEmail("OWNER@example.com", list)).toBe(true);
    expect(isPlatformAdminEmail("someone@example.com", list)).toBe(false);
    expect(isPlatformAdminEmail(null, list)).toBe(false);
  });

  it("lets in nobody when the variable isn't set", () => {
    expect(
      isPlatformAdminEmail("owner@example.com", parseAdminEmails("")),
    ).toBe(false);
  });
});
