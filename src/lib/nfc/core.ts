/**
 * NFC table tags: a sticker holding the table's link, so a guest can tap
 * their phone instead of scanning the QR code. It's the same link as the
 * table's QR code (buildTableQrUrl), so the same session starts either way.
 *
 * Writing happens in the browser with Web NFC, which only Chrome on
 * Android has; iPhones read tags but no iPhone browser can write them, so
 * those owners get the link and steps for a free app instead.
 *
 * Pure and free of `server-only` (tests/unit/nfc-core.test.ts).
 */

/** Whether this browser can write a tag itself. */
export function canWriteNfc(win: unknown): boolean {
  return (
    typeof win === "object" &&
    win !== null &&
    "NDEFReader" in (win as Record<string, unknown>)
  );
}

/** The one record a table tag holds: its link. */
export function tableTagMessage(url: string) {
  return { records: [{ recordType: "url" as const, data: url }] };
}

/**
 * NTAG213, the common sticker, holds 144 bytes; a URL record and its
 * framing take about 10 of them. A table link is normally around 85
 * characters, but a long restaurant slug could push it over.
 */
export const NTAG213_MAX_URL = 130;

export function needsBiggerTag(url: string): boolean {
  return new TextEncoder().encode(url).length > NTAG213_MAX_URL;
}

/** Web NFC's errors, as sentences an owner holding a sticker can act on. */
export function nfcErrorMessage(name: string | undefined): string {
  switch (name) {
    case "NotAllowedError":
      return "Chrome wasn't allowed to use NFC. Allow it when asked, and check NFC is on in your phone's settings.";
    case "NotSupportedError":
      return "That tag can't be written. It may already be locked, or not be an NFC sticker this phone can write.";
    case "NetworkError":
      return "The tag moved away before it finished. Hold it still against the back of the phone and try again.";
    case "AbortError":
      return "Stopped.";
    default:
      return "That didn't work. Hold the sticker flat against the back of the phone and try again.";
  }
}
