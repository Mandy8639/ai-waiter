// @vitest-environment jsdom
//
// The privacy policy at /privacy. Google Play requires a reachable policy
// URL, and the policy is where data-deletion requests are sent, so: anyone
// can open it without signing in, it gives the contact address, the
// statements Play's Data safety answers rely on are there, and the pages
// that should link to it do.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import PrivacyPolicyPage from "@/app/privacy/page";
import { decideRouteAccess } from "@/lib/auth/route-access";
import {
  PRIVACY_CONTACT_EMAIL,
  PRIVACY_POLICY_PATH,
} from "@/lib/legal/privacy";

afterEach(cleanup);

describe("the privacy policy page", () => {
  it("names the operator and gives the contact address as a mail link", () => {
    render(<PrivacyPolicyPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Privacy policy" }),
    ).toBeVisible();
    expect(
      screen.getAllByText(/Beacon Digital Consulting LLC/).length,
    ).toBeGreaterThan(0);
    const links = screen.getAllByRole("link", { name: PRIVACY_CONTACT_EMAIL });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", `mailto:${PRIVACY_CONTACT_EMAIL}`);
    }
  });

  it("states what Play's Data safety answers rely on", () => {
    const { container } = render(<PrivacyPolicyPage />);
    const text = container.textContent ?? "";
    for (const statement of [
      // Account deletion: Play requires a way to request it.
      "Delete your account:",
      // Card data never touches Tableside.
      "never reach Tableside",
      // Voice: the browser's service, never our servers.
      "Tableside never receives audio",
      // No selling, no ads.
      "We don't sell personal information",
      // AI providers are named, with the allergy caveat.
      "Anthropic",
      "OpenRouter",
      "always confirm with the restaurant",
      // Honest about what isn't deleted automatically.
      "We don't delete them automatically",
      // The iPhone app's alerts go through Apple (App Store privacy answers).
      "a device token issued by Apple",
    ]) {
      expect(text, statement).toContain(statement);
    }
  });
});

describe("reaching it", () => {
  it("is open to everyone, signed in or not, and never redirects", () => {
    for (const visitor of [
      { signedIn: false, isAnonymous: false },
      { signedIn: true, isAnonymous: true },
      { signedIn: true, isAnonymous: false },
    ]) {
      expect(decideRouteAccess(PRIVACY_POLICY_PATH, visitor)).toEqual({
        type: "continue",
      });
    }
  });

  it.each([
    "src/app/page.tsx",
    "src/app/login/page.tsx",
    "src/app/signup/page.tsx",
  ])("is linked from %s", (file) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    expect(source).toContain("href={PRIVACY_POLICY_PATH}");
  });
});
