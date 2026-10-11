// @vitest-environment jsdom
//
// The support page at /support. The App Store requires a Support URL that
// leads to real contact details, so: anyone can open it without signing in,
// the store apps don't redirect it, it gives a working mail link, it never
// sells a plan (it opens inside the apps), and the pages that should link to
// it do.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import SupportPage from "@/app/support/page";
import { appShellRedirect } from "@/lib/app-shell/core";
import { decideRouteAccess } from "@/lib/auth/route-access";
import { SUPPORT_CONTACT_EMAIL, SUPPORT_PATH } from "@/lib/legal/support";

afterEach(cleanup);

describe("the support page", () => {
  it("gives the contact address as a mail link, and names the operator", () => {
    render(<SupportPage />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Support" }),
    ).toBeVisible();
    const links = screen.getAllByRole("link", { name: SUPPORT_CONTACT_EMAIL });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute("href", `mailto:${SUPPORT_CONTACT_EMAIL}`);
    }
    expect(screen.getByText(/Beacon Digital Consulting LLC/)).toBeVisible();
  });

  it("links the privacy policy and never mentions plans or prices", () => {
    const { container } = render(<SupportPage />);
    expect(
      screen.getByRole("link", { name: "privacy policy" }),
    ).toHaveAttribute("href", "/privacy");
    expect(container.textContent).not.toMatch(/\$|plan|price|subscri/i);
  });
});

describe("reaching it", () => {
  it("is open to everyone and the store apps don't redirect it", () => {
    for (const visitor of [
      { signedIn: false, isAnonymous: false },
      { signedIn: true, isAnonymous: true },
      { signedIn: true, isAnonymous: false },
    ]) {
      expect(decideRouteAccess(SUPPORT_PATH, visitor)).toEqual({
        type: "continue",
      });
    }
    expect(appShellRedirect(SUPPORT_PATH, "ios")).toBeNull();
    expect(appShellRedirect(SUPPORT_PATH, "android")).toBeNull();
  });

  it.each(["src/app/page.tsx", "src/app/login/page.tsx"])(
    "is linked from %s",
    (file) => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toContain("href={SUPPORT_PATH}");
    },
  );
});
