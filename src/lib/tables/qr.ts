import "server-only";
import { headers } from "next/headers";
import QRCode from "qrcode";

/**
 * The origin (scheme + host) of the current request, derived from headers
 * rather than a hardcoded env var — works correctly in dev, preview, and
 * production without extra configuration. QR codes need an absolute URL
 * (a phone scanning them has no "relative to this app" context), so this
 * is what makes that possible without a dedicated NEXT_PUBLIC_SITE_URL.
 */
export async function getRequestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const forwardedProto = h.get("x-forwarded-proto");
  const proto =
    forwardedProto ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  return `${proto}://${host}`;
}

export function buildTableQrUrl(
  origin: string,
  restaurantSlug: string,
  publicToken: string,
): string {
  return `${origin}/r/${encodeURIComponent(restaurantSlug)}/table/${encodeURIComponent(publicToken)}`;
}

/** A PNG data URL — embeddable directly in <img src>, and downloadable as-is via <a download>. */
export async function generateTableQrDataUrl(url: string): Promise<string> {
  return QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 384,
  });
}
