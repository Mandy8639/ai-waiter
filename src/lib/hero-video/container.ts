/**
 * Deciding whether some bytes are really the video they claim to be —
 * without a decoder.
 *
 * WHY THIS EXISTS. A dish photo is validated by actually decoding it:
 * sharp opens it, and anything that is not an image fails loudly. A hero
 * video has no equivalent, because this system has no ffmpeg and is not
 * getting one. The video is stored and served exactly as uploaded, so
 * something has to answer "is this a video?" before a restaurant's menu
 * links to it publicly.
 *
 * WHAT THIS IS, AND IS NOT. This reads the container header — the first
 * few dozen bytes that say "MP4" or "WebM". It is a real check: a renamed
 * .exe, an HTML error page, a PDF, a ZIP and a JPEG all fail it. It is NOT
 * a decode: it cannot tell you the file plays, how long it is, what codec
 * the video track uses, or whether the rest of the file is intact. A
 * hostile file that begins with a valid MP4 header and continues with
 * anything at all will pass.
 *
 * That residual risk is bounded by what browsers do with it: the object is
 * served from a bucket whose MIME allow-list is video-only, under a
 * Content-Type the bucket enforces, from an origin that hosts nothing else.
 * A browser handed an `video/mp4` response that it cannot decode shows a
 * broken player. It does not execute it.
 *
 * The rest of the defence is procedural and stronger: an uploaded video is
 * private until an owner has watched it and published it.
 */

/** Enough bytes for an MP4 `ftyp` box with a long compatible-brands list. */
export const HEADER_BYTES = 64;

export type VideoContainer = "video/mp4" | "video/webm";

export class VideoRejected extends Error {
  constructor(
    readonly code:
      "UNREADABLE" | "UNSUPPORTED_CONTAINER" | "TOO_LARGE" | "TOO_SMALL",
    message: string,
  ) {
    super(message);
    this.name = "VideoRejected";
  }
}

export const VIDEO_LIMITS = {
  /** Matches the bucket's own ceiling, so both refuse the same thing. */
  maxBytes: 50 * 1024 * 1024,
  /**
   * A video shorter than this in bytes is not a video anyone shot; it is
   * almost always a failed export or a truncated upload.
   */
  minBytes: 10 * 1024,
} as const;

/**
 * MP4 brands we accept. `qt  ` is deliberately absent: an iPhone .mov is
 * QuickTime, and while Safari plays it, Chrome's support depends on the
 * codec inside. Accepting it would mean a hero video that works for the
 * restaurant owner testing on their iPhone and shows a broken player to
 * half their diners — the worst possible failure, because nobody would
 * ever hear about it.
 */
const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso4",
  "iso5",
  "iso6",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "M4V ",
]);

/**
 * Identifies the container, or throws. `declared` is what the browser said
 * the file was; it must agree with the bytes, so that a .webm renamed to
 * .mp4 cannot end up stored with a Content-Type it will not play under.
 */
export function detectContainer(
  header: Buffer,
  declared: string,
): VideoContainer {
  if (header.byteLength < 12) {
    throw new VideoRejected("UNREADABLE", "That file could not be read.");
  }

  const actual = sniff(header);
  if (!actual) {
    throw new VideoRejected(
      "UNSUPPORTED_CONTAINER",
      "That file doesn't look like an MP4 or WebM video.",
    );
  }
  if (actual !== declared) {
    throw new VideoRejected(
      "UNSUPPORTED_CONTAINER",
      "That file's contents don't match its type. Try exporting it again.",
    );
  }
  return actual;
}

function sniff(header: Buffer): VideoContainer | null {
  // Matroska/WebM: the EBML magic, at byte 0.
  if (
    header[0] === 0x1a &&
    header[1] === 0x45 &&
    header[2] === 0xdf &&
    header[3] === 0xa3
  ) {
    return "video/webm";
  }

  // ISO base media (MP4): a box whose type is "ftyp" at byte 4, with the
  // major brand in the following four bytes.
  if (header.subarray(4, 8).toString("latin1") === "ftyp") {
    const major = header.subarray(8, 12).toString("latin1");
    if (MP4_BRANDS.has(major)) return "video/mp4";
    // Some encoders put a brand we do not know in `major` but a familiar
    // one in the compatible-brands list that follows.
    for (let offset = 16; offset + 4 <= header.byteLength; offset += 4) {
      if (
        MP4_BRANDS.has(header.subarray(offset, offset + 4).toString("latin1"))
      ) {
        return "video/mp4";
      }
    }
  }

  return null;
}

/** Size check, kept next to the container check so both refusals read alike. */
export function checkVideoSize(byteSize: number): void {
  if (byteSize > VIDEO_LIMITS.maxBytes) {
    throw new VideoRejected(
      "TOO_LARGE",
      `That video is ${Math.round(byteSize / 1024 / 1024)} MB; the limit is ${VIDEO_LIMITS.maxBytes / 1024 / 1024} MB.`,
    );
  }
  if (byteSize < VIDEO_LIMITS.minBytes) {
    throw new VideoRejected(
      "TOO_SMALL",
      "That video is too small to be a real recording.",
    );
  }
}
