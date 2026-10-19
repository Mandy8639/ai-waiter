// A platform admin with no restaurant lands on the Admin page instead of
// "Create your restaurant" (src/app/dashboard/layout.tsx), and the Admin
// page then offers Account and Log out rather than a Dashboard link that
// would only bounce back (src/app/admin/page.tsx).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("an admin without a restaurant", () => {
  it("is sent from the dashboard to /admin before the onboarding prompt", () => {
    const layout = read("src/app/dashboard/layout.tsx");
    const none = layout.indexOf('state.status === "none"');
    const sent = layout.indexOf('if (showAdmin) redirect("/admin");');
    const prompt = layout.indexOf("Create your restaurant");
    expect(none).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(none);
    expect(sent).toBeLessThan(prompt);
  });

  it("gets Account and Log out on the Admin page, not a Dashboard link", () => {
    const page = read("src/app/admin/page.tsx");
    expect(page).toMatch(/hasRestaurant \? \(/);
    expect(page).toContain("<LogoutButton />");
  });
});
