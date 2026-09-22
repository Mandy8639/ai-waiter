/**
 * Decode, validate, sanitize and resize a restaurant's uploaded photo.
 *
 * Runs on the server only, in the Node runtime — sharp is a native binding
 * and cannot run on Edge. Anything importing this module must therefore not
 * declare `export const runtime = "edge"`.
 *
 * Deliberately free of `server-only` so it can be unit-tested directly, in
 * the repository's usual core/wrapper split: the wrapper that reaches
 * Storage carries the import, this pure function of a Buffer does not.
 *
 * The rule throughout: the client's claims are worthless. Its Content-Type
 * header, its file name and its extension are all attacker-controlled, so
 * none of them decide anything here. The format is whatever libvips reports
 * after actually decoding the bytes, and a file that does not decode is
 * refused rather than stored and worried about later.
 *
 * Nothing from the source survives into a published variant except the
 * pixels: sharp emits no EXIF, XMP, IPTC or ICC block unless explicitly
 * asked to, and this module never asks. Orientation is the one piece of
 * metadata that must be honoured before it is dropped, or a photo taken in
 * portrait would be published on its side — `.rotate()` with no argument
 * bakes the EXIF orientation into the pixels, after which the tag is gone
 * along with everything else, GPS coordinates included.
 */
import sharp from "sharp";
import { createHash } from "node:crypto";

/** What libvips must report for us to accept the upload. Not the MIME header. */
export const ACCEPTED_FORMATS = ["jpeg", "png", "webp"] as const;
export type AcceptedFormat = (typeof ACCEPTED_FORMATS)[number];

/**
 * HEIC/HEIF is deliberately absent. This libvips build decodes it, but the
 * prebuilt binary sharp ships per-platform does not reliably, and an iPhone
 * set to "Most Compatible" — the default when sharing — already sends JPEG.
 * Adding it would mean a format that works locally and fails in production
 * for a subset of users, which is worse than not offering it.
 */

export const LIMITS = {
  /** Matches the private bucket's own ceiling, so both refuse the same thing. */
  maxBytes: 15 * 1024 * 1024,
  /**
   * A decompression-bomb guard. 40 MP passes any phone or DSLR photo (a
   * 12 MP iPhone shot is 12e6; a 61 MP studio camera would be refused, and
   * that is not a menu photo). Enforced twice: as a libvips input limit so
   * a hostile file is abandoned *during* decode rather than after, and as
   * an explicit check on the reported dimensions.
   */
  maxPixels: 40_000_000,
  /** No single side may be absurd, even inside the pixel budget (e.g. 1 x 40M). */
  maxSide: 12_000,
  /** Below this there is nothing worth publishing; almost certainly a mistake. */
  minSide: 200,
} as const;

/**
 * Published widths, chosen from what the diner UI actually renders:
 *   - menu cards draw at 96-112 CSS px (size-24 / sm:size-28), so 400
 *     covers a 3x device;
 *   - the dish page draws full-bleed inside max-w-2xl, about 640 CSS px at
 *     most and ~330-400 on a phone, so 800 covers a 2x phone and 1600
 *     covers 3x phones and desktop.
 * Aspect ratio is preserved; the UI crops with object-cover, so cropping
 * here would only throw away pixels the layout might later want.
 */
export const VARIANTS = [
  { name: "small", width: 400 },
  { name: "medium", width: 800 },
  { name: "large", width: 1600 },
] as const;

export type VariantName = (typeof VARIANTS)[number]["name"];

/** WebP everywhere: universally supported now, and markedly smaller than JPEG at equal quality. */
const WEBP_QUALITY = 80;

export interface ProcessedVariant {
  name: VariantName;
  width: number;
  height: number;
  bytes: number;
  body: Buffer;
}

export interface ProcessedImage {
  /** The decoded source, for the record phase 1 keeps. */
  source: {
    format: AcceptedFormat;
    width: number;
    height: number;
    bytes: number;
    sha256: string;
  };
  variants: ProcessedVariant[];
}

export class ImageRejected extends Error {
  constructor(
    readonly code:
      | "UNREADABLE"
      | "UNSUPPORTED_FORMAT"
      | "TOO_LARGE"
      | "TOO_MANY_PIXELS"
      | "SIDE_TOO_LONG"
      | "TOO_SMALL",
    message: string,
  ) {
    super(message);
    this.name = "ImageRejected";
  }
}

/**
 * Which variants to produce for a source of this width.
 *
 * Never upscales, and never emits two variants of the same size: a 500px
 * source yields small(400) and medium(500), not three near-identical files.
 * `small` is always produced so every image has a card thumbnail.
 */
export function plannedVariants(
  sourceWidth: number,
): Array<{ name: VariantName; width: number }> {
  const planned: Array<{ name: VariantName; width: number }> = [
    { name: "small", width: Math.min(VARIANTS[0].width, sourceWidth) },
  ];
  for (const variant of VARIANTS.slice(1)) {
    const previous = planned[planned.length - 1].width;
    if (sourceWidth > previous) {
      planned.push({
        name: variant.name,
        width: Math.min(variant.width, sourceWidth),
      });
    }
  }
  return planned;
}

/**
 * Validates the bytes and returns sanitized WebP variants.
 *
 * Throws ImageRejected for anything a restaurant could plausibly have sent
 * by accident or on purpose; the caller turns that into a customer-safe
 * message and fails the image record. It never writes anything.
 */
export async function processUploadedImage(
  body: Buffer,
): Promise<ProcessedImage> {
  if (body.byteLength > LIMITS.maxBytes) {
    throw new ImageRejected(
      "TOO_LARGE",
      `Image is ${Math.round(body.byteLength / 1024 / 1024)} MB; the limit is ${LIMITS.maxBytes / 1024 / 1024} MB.`,
    );
  }

  // limitInputPixels makes libvips give up on a decompression bomb while
  // decoding, instead of after allocating it. failOn "error" rejects a
  // truncated or corrupt file rather than rendering the part that parsed.
  const open = () =>
    sharp(body, { limitInputPixels: LIMITS.maxPixels, failOn: "error" });

  let metadata;
  try {
    metadata = await open().metadata();
  } catch {
    throw new ImageRejected(
      "UNREADABLE",
      "That file could not be read as an image.",
    );
  }

  const format = metadata.format as AcceptedFormat | undefined;
  if (!format || !ACCEPTED_FORMATS.includes(format)) {
    throw new ImageRejected(
      "UNSUPPORTED_FORMAT",
      "Please upload a JPEG, PNG or WebP photo.",
    );
  }

  // After .rotate(), width/height are the *displayed* ones. metadata gives
  // the stored ones, which for a 90-degree EXIF orientation are swapped —
  // so ask for the oriented size rather than trusting the stored pair.
  //
  // This is also the first point at which the pixels are actually decoded.
  // A truncated file has a perfectly good header, so metadata() above
  // succeeds and the failure surfaces only here — as a raw libvips error
  // ("premature end of JPEG image") that would otherwise escape this module
  // uncaught and reach the caller as a 500 rather than a refusal.
  let width: number;
  let height: number;
  try {
    const oriented = await open()
      .rotate()
      .toBuffer({ resolveWithObject: true });
    width = oriented.info.width;
    height = oriented.info.height;
  } catch {
    throw new ImageRejected(
      "UNREADABLE",
      "That image is damaged or incomplete.",
    );
  }

  if (width * height > LIMITS.maxPixels) {
    throw new ImageRejected(
      "TOO_MANY_PIXELS",
      "That image has too many pixels to process.",
    );
  }
  if (width > LIMITS.maxSide || height > LIMITS.maxSide) {
    throw new ImageRejected(
      "SIDE_TOO_LONG",
      "That image is too large in one dimension.",
    );
  }
  if (width < LIMITS.minSide || height < LIMITS.minSide) {
    throw new ImageRejected(
      "TOO_SMALL",
      `Photos need to be at least ${LIMITS.minSide} pixels on each side.`,
    );
  }

  const variants: ProcessedVariant[] = [];
  try {
    for (const planned of plannedVariants(width)) {
      const out = await open()
        // Bakes EXIF orientation into the pixels; the tag itself is then
        // dropped with the rest of the metadata, GPS included.
        .rotate()
        .resize({ width: planned.width, withoutEnlargement: true })
        // No .withMetadata() anywhere: sharp emits none by default, which is
        // exactly what a published image should carry.
        .webp({ quality: WEBP_QUALITY })
        .toBuffer({ resolveWithObject: true });

      variants.push({
        name: planned.name,
        width: out.info.width,
        height: out.info.height,
        bytes: out.info.size,
        body: out.data,
      });
    }
  } catch (error) {
    if (error instanceof ImageRejected) throw error;
    // Same reasoning as the decode above: a file that survives the first
    // pass can still fail while being resized, and that is a refusal, not
    // an internal error.
    throw new ImageRejected("UNREADABLE", "That image could not be processed.");
  }

  return {
    source: {
      format,
      width,
      height,
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
    variants,
  };
}
