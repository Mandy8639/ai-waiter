/**
 * A restaurant's web address (its slug: tableside.menu/r/<slug>), made
 * from its name so an owner never has to invent one. No `server-only`,
 * per the extract-the-core convention.
 */

export const SLUG_MAX_LENGTH = 60;

/** "Café Spice & Grill!" → "cafe-spice-and-grill". Never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "restaurant";
}

/**
 * Addresses to try, in order, when the one made from the name is taken:
 * "spice-garden", "spice-garden-2" … "-4", then one with a random tail so
 * the last try can't collide in practice.
 */
export function slugCandidates(
  base: string,
  random: () => string = () => Math.random().toString(36).slice(2, 6),
): string[] {
  const trimmed = base.slice(0, SLUG_MAX_LENGTH - 5).replace(/-+$/g, "");
  return [
    base,
    `${trimmed}-2`,
    `${trimmed}-3`,
    `${trimmed}-4`,
    `${trimmed}-${random()}`,
  ];
}

/** Whether a string is a real IANA timezone this runtime knows ("America/Chicago"). */
export function isValidTimeZone(zone: string): boolean {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
