// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BUSINESS_CARD,
  buildVCard,
  formatUsPhone,
  whatsappUrl,
} from "@/lib/marketing/business-card";

describe("business card", () => {
  const full = {
    ...BUSINESS_CARD,
    phone: "+17325550123",
    email: "hello@example.com",
  };

  it("builds a vCard 3.0 with CRLF line endings", () => {
    const v = buildVCard(full);
    expect(v.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n")).toBe(true);
    expect(v.endsWith("END:VCARD\r\n")).toBe(true);
    expect(v).toContain("N:Gouraram;Manideep;;;\r\n");
    expect(v).toContain("TEL;TYPE=CELL,VOICE:+17325550123\r\n");
    expect(v).toContain("EMAIL;TYPE=INTERNET:hello@example.com\r\n");
  });

  it("escapes commas and semicolons in text fields", () => {
    const v = buildVCard({ ...full, note: "Free; then $29, locked" });
    expect(v).toContain("NOTE:Free\\; then $29\\, locked\r\n");
  });

  it("leaves out an empty phone or email", () => {
    const v = buildVCard({ ...full, phone: "", email: "" });
    expect(v).not.toContain("TEL");
    expect(v).not.toContain("EMAIL");
  });

  it("formats US numbers and builds WhatsApp links", () => {
    expect(formatUsPhone("+17325550123")).toBe("(732) 555-0123");
    expect(formatUsPhone("+919876543210")).toBe("+919876543210");
    expect(whatsappUrl("+1 (732) 555-0123")).toBe("https://wa.me/17325550123");
  });
});
