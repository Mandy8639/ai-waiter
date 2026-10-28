/**
 * Importing a menu from a link to the restaurant's own menu or ordering
 * page: which links are allowed, which addresses may be fetched, and how
 * a page becomes text for the menu reader. Pure, so it's unit-tested
 * (tests/unit/menu-import-link.test.ts); src/lib/menu-import/link.ts does
 * the fetching.
 *
 * The server fetches a URL a user typed, so the address checks matter:
 * without them a link could make the server read its own network
 * (169.254.169.254, localhost, a private range). They run on every
 * address the name resolves to, at connect time, and again on every
 * redirect.
 */

export class MenuLinkError extends Error {}

/** How much page text the reader gets: enough for a long menu, bounded for the model. */
export const MAX_MENU_TEXT = 60_000;
/** Below this, the page almost certainly builds its menu with JavaScript. */
export const MIN_MENU_TEXT = 200;

/** A link the owner pasted, as a URL we're willing to fetch, or a reason why not. */
export function parseMenuLink(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new MenuLinkError("Paste the link to your menu.");
  let url: URL;
  try {
    url = new URL(
      /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`,
    );
  } catch {
    throw new MenuLinkError("That doesn't look like a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MenuLinkError("Use a link that starts with https://.");
  }
  if (url.username || url.password) {
    throw new MenuLinkError(
      "Use the menu's public link, without a login in it.",
    );
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new MenuLinkError("Use the menu's normal public link.");
  }
  if (
    !url.hostname.includes(".") ||
    /^\d+(\.\d+){3}$/.test(url.hostname) ||
    url.hostname.startsWith("[")
  ) {
    throw new MenuLinkError(
      "Use the menu's public link, with its web address.",
    );
  }
  return url;
}

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  return nums.every((n, i) => /^\d{1,3}$/.test(parts[i]) && n <= 255)
    ? nums
    : null;
}

/** Whether an address is on the public internet (not private, local, or reserved). */
export function isPublicAddress(ip: string): boolean {
  const v4 = ipv4Parts(ip);
  if (v4) {
    const [a, b] = v4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224 // multicast and reserved
    );
  }

  const v6 = ip.toLowerCase();
  if (!v6.includes(":")) return false;
  // IPv4 written as IPv6 (::ffff:10.0.0.1) is judged as IPv4.
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  return !(
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") || // unique local
    /^fe[89ab]/.test(v6) || // link-local
    v6.startsWith("ff") || // multicast
    v6.startsWith("::ffff:") ||
    v6.startsWith("64:ff9b:") || // NAT64
    v6.startsWith("2001:db8:") // documentation
  );
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, code: string) => {
      if (code[0] === "#") {
        const n =
          code[1] === "x" || code[1] === "X"
            ? parseInt(code.slice(2), 16)
            : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000
          ? String.fromCodePoint(n)
          : match;
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    },
  );
}

/**
 * The menu-bearing text of a page: structured data first (schema.org Menu
 * in JSON-LD, and the JSON ordering sites embed for their own app, which
 * is often where the dishes and prices are when the visible page is built
 * by JavaScript), then the visible text. Capped at MAX_MENU_TEXT.
 */
export function menuTextFromHtml(html: string): string {
  const blocks: string[] = [];

  const scriptJson =
    /<script\b[^>]*type=["']?(application\/ld\+json|application\/json)["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptJson)) {
    const body = match[2].trim();
    // Only JSON that looks like it has dishes and prices in it.
    if (body.length > 50 && /price/i.test(body) && /(name|title)/i.test(body)) {
      blocks.push(body);
    }
  }

  const visible = decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi,
        " ",
      )
      .replace(
        /<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (visible) blocks.push(visible);

  return blocks.join("\n\n").slice(0, MAX_MENU_TEXT);
}

/** Splits menu text into pieces the reader can take one at a time, on line breaks. */
export function chunkMenuText(text: string, size = 20_000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > size) {
      chunks.push(current);
      current = "";
    }
    current = current
      ? `${current}\n${line.slice(0, size)}`
      : line.slice(0, size);
  }
  if (current) chunks.push(current);
  return chunks;
}

/** The instruction sent with page text: the photo prompt's rules, for text. */
export const LINK_EXTRACTION_PROMPT = `Below is the text of a restaurant's menu web page (it may include the page's structured data as JSON). Find the menu and return ONLY JSON, with no prose or explanation:
{"categories":[{"name":"...","items":[{"name":"...","price":number|null}]}]}

Rules:
- Only dishes and drinks the restaurant sells. Ignore navigation, opening hours, reviews, addresses, delivery fees and anything else that isn't a menu item.
- "price" must be a NUMBER in the menu's currency units (12.5 for $12.50), or null.
- NEVER invent, estimate, or infer a price. If the page does not clearly state one, use null. Prices in structured data may be in cents (1250 for $12.50): only convert when the page makes that unmistakable; otherwise use null.
- Copy item names exactly as written.
- Use the menu's own section names. If an item has no section, put it in a category called "Uncategorised".
- Include every item. Do not summarise or skip. If this text has no menu items at all, return {"categories":[]}.

The page:
`;
