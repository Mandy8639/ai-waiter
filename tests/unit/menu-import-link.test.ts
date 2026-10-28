import { describe, expect, it } from "vitest";
import {
  LINK_EXTRACTION_PROMPT,
  MAX_MENU_TEXT,
  MenuLinkError,
  chunkMenuText,
  isPublicAddress,
  menuTextFromHtml,
  parseMenuLink,
} from "../../src/lib/menu-import/link-core";

// Importing a menu from a link (src/lib/menu-import/link-core.ts): the
// server fetches what an owner pastes, so which links and addresses it
// will touch is the part that must not regress.

describe("which links are accepted", () => {
  it("takes a normal menu link, adding https:// when it's missing", () => {
    expect(parseMenuLink("https://saffron.example.com/menu").toString()).toBe(
      "https://saffron.example.com/menu",
    );
    expect(parseMenuLink("  saffron.example.com/menu ").toString()).toBe(
      "https://saffron.example.com/menu",
    );
  });

  it.each([
    ["", /Paste the link/],
    ["ftp://saffron.example.com/menu", /web address|https/],
    ["javascript:alert(1)", /web address|https/],
    ["https://user:pass@saffron.example.com/menu", /without a login/],
    ["https://saffron.example.com:8080/menu", /normal public link/],
    ["http://localhost/menu", /public link/],
    ["http://169.254.169.254/latest/meta-data", /public link/],
    ["http://10.0.0.1/menu", /public link/],
    ["http://[::1]/menu", /public link/],
  ])("refuses %j", (raw, message) => {
    expect(() => parseMenuLink(raw)).toThrow(MenuLinkError);
    expect(() => parseMenuLink(raw)).toThrow(message);
  });
});

describe("which addresses may be fetched", () => {
  it.each(["93.184.215.14", "151.101.1.69", "2606:4700::6810:84e5"])(
    "allows the public address %s",
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "not-an-ip",
  ])("refuses %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
});

describe("page text for the reader", () => {
  const page = `<!doctype html><html><head><title>Saffron &amp; Sage</title>
    <style>.x{color:red}</style><script>window.track = "price: 1";</script></head>
    <body><nav>Home | Order</nav>
    <h2>Starters</h2><ul><li>Samosa (2) &ndash; $6.50</li><li>Chicken&nbsp;65 $12</li></ul>
    <!-- hidden: Lobster $99 -->
    <script type="application/ld+json">{"@type":"Menu","hasMenuSection":[{"name":"Curries","hasMenuItem":[{"name":"Palak Paneer","offers":{"price":"15.00"}}]}]}</script>
    </body></html>`;

  it("keeps dishes and prices, structured data first, and drops code and comments", () => {
    const text = menuTextFromHtml(page);
    expect(text.indexOf("Palak Paneer")).toBeLessThan(text.indexOf("Samosa"));
    expect(text).toContain("Samosa (2) – $6.50");
    expect(text).toContain("Chicken 65 $12");
    expect(text).not.toContain("window.track");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("Lobster");
    expect(text).not.toContain("Saffron & Sage"); // the <head> is not the menu
  });

  it("is capped, so a huge page can't run up the reader", () => {
    const huge = `<p>${"Masala Dosa $11\n".repeat(20_000)}</p>`;
    expect(menuTextFromHtml(huge).length).toBeLessThanOrEqual(MAX_MENU_TEXT);
  });

  it("splits long text on line breaks, in order", () => {
    const text = Array.from({ length: 100 }, (_, i) => `Dish ${i} $${i}`).join(
      "\n",
    );
    const chunks = chunkMenuText(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join("\n")).toBe(text);
  });

  it("asks the reader never to guess a price", () => {
    expect(LINK_EXTRACTION_PROMPT).toMatch(
      /NEVER invent, estimate, or infer a price/,
    );
    expect(LINK_EXTRACTION_PROMPT).toMatch(/null/);
  });
});
