import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

/**
 * The sitemap lists only public marketing pages on the production domain,
 * and robots.txt points to it while keeping crawlers out of signed-in and
 * per-diner pages. Restaurant pages stay out of the sitemap until test and
 * demo restaurants can be told apart from real ones.
 */
describe("sitemap.xml", () => {
  const urls = sitemap().map((entry) => entry.url);

  it("lists public pages on tableside.menu only", () => {
    expect(urls).toEqual([
      "https://tableside.menu/",
      "https://tableside.menu/signup",
      "https://tableside.menu/login",
      "https://tableside.menu/support",
      "https://tableside.menu/security",
      "https://tableside.menu/privacy",
    ]);
  });

  it("never lists signed-in, per-diner or restaurant pages", () => {
    for (const url of urls) {
      expect(url).not.toMatch(/\/(dashboard|account|onboarding|api|auth|r)\b/);
    }
  });
});

describe("robots.txt", () => {
  const result = robots();
  const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;

  it("points to the sitemap", () => {
    expect(result.sitemap).toBe("https://tableside.menu/sitemap.xml");
  });

  it("keeps crawlers out of signed-in and per-diner pages", () => {
    expect(rules.disallow).toEqual(
      expect.arrayContaining(["/dashboard", "/account", "/api/", "/r/*/cart"]),
    );
    expect(rules.allow).toBe("/");
  });
});
