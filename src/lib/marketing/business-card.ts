/**
 * The founder's business card: one source for the printed card's QR page
 * (/card) and the contact file it offers (/card/vcard).
 *
 * The printed card's QR code points at https://tableside.menu/card, so the
 * details can change here without reprinting. An empty phone or email is
 * left off the page and the contact file, not shown as a blank.
 *
 * Pure (no server-only imports) so it can be unit tested.
 */

export interface BusinessCard {
  name: string;
  /** Given and family name, for the vCard N field. */
  givenName: string;
  familyName: string;
  title: string;
  company: string;
  /** E.164, e.g. "+17325550123". Empty to leave it off. */
  phone: string;
  email: string;
  url: string;
  /** The offer line under the name. */
  offer: string;
}

export const BUSINESS_CARD: BusinessCard = {
  name: "Manideep Gouraram",
  givenName: "Manideep",
  familyName: "Gouraram",
  title: "Founder",
  company: "Tableside",
  phone: "",
  email: "",
  url: "https://tableside.menu",
  offer:
    "Founding Table: 5 restaurants. Free for 90 days, then $29 a month, locked for 12 months. No contract.",
};

/** "+17325550123" → "(732) 555-0123"; anything else is shown as given. */
export function formatUsPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** wa.me wants digits only, country code first. */
export function whatsappUrl(e164: string): string {
  return `https://wa.me/${e164.replace(/\D/g, "")}`;
}

/** RFC 6350 text escaping: backslash, comma, semicolon, newline. */
function esc(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;")
    .replace(/\r?\n/g, "\\n");
}

/**
 * A vCard 3.0 (the version iPhone and Android contacts both import from a
 * downloaded .vcf). Lines end in CRLF, as the format requires.
 */
export function buildVCard(card: BusinessCard): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${esc(card.familyName)};${esc(card.givenName)};;;`,
    `FN:${esc(card.name)}`,
    `ORG:${esc(card.company)}`,
    `TITLE:${esc(card.title)}`,
  ];
  if (card.phone) lines.push(`TEL;TYPE=CELL,VOICE:${card.phone}`);
  if (card.email) lines.push(`EMAIL;TYPE=INTERNET:${card.email}`);
  lines.push(`URL:${card.url}`);
  lines.push(`NOTE:${esc(card.offer)}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}
