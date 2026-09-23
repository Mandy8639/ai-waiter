// @vitest-environment node
import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  ImageRejected,
  LIMITS,
  plannedVariants,
  processUploadedImage,
} from "@/lib/menu-images/processing";

/**
 * Real images, decoded by the real libvips. Nothing here is mocked: the
 * behaviour under test *is* the decoding, the metadata handling and the
 * resizing, so a stub would assert only that the stub was called.
 *
 * The security-relevant claims — a hostile file is refused, EXIF and GPS
 * never reach a published variant — are worth nothing unless the bytes are
 * genuinely put through sharp.
 */

/** A recognisable photo-ish image: gradients survive WebP, flat colour hides bugs. */
async function photo(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 120, b: 60 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

/** A JPEG carrying EXIF, including GPS coordinates and an orientation tag. */
async function photoWithExif(
  width: number,
  height: number,
  orientation = 1,
): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 10, g: 140, b: 90 },
    },
  })
    .withExif({
      IFD0: {
        Make: "TestCam",
        Model: "Privacy Leak 9000",
        Orientation: String(orientation),
      },
      IFD3: {
        GPSLatitudeRef: "N",
        GPSLatitude: "51/1 30/1 0/1",
        GPSLongitudeRef: "W",
        GPSLongitude: "0/1 7/1 0/1",
      },
    })
    .withMetadata({ orientation })
    .jpeg()
    .toBuffer();
}

describe("plannedVariants", () => {
  it("produces all three for a normal phone photo", () => {
    expect(plannedVariants(3024)).toEqual([
      { name: "small", width: 400 },
      { name: "medium", width: 800 },
      { name: "large", width: 1600 },
    ]);
  });

  it("never upscales: a small source caps every variant at its own width", () => {
    expect(plannedVariants(500)).toEqual([
      { name: "small", width: 400 },
      { name: "medium", width: 500 },
    ]);
  });

  it("emits a single variant when the source is no wider than the thumbnail", () => {
    expect(plannedVariants(320)).toEqual([{ name: "small", width: 320 }]);
  });

  it("never emits two variants of the same width", () => {
    for (const width of [200, 320, 399, 400, 401, 800, 801, 1600, 4000]) {
      const widths = plannedVariants(width).map((v) => v.width);
      expect(new Set(widths).size).toBe(widths.length);
    }
  });
});

describe("processUploadedImage", () => {
  it("accepts a JPEG and returns webp variants", async () => {
    const result = await processUploadedImage(await photo(2000, 1500));

    expect(result.source.format).toBe("jpeg");
    expect(result.source.width).toBe(2000);
    expect(result.source.height).toBe(1500);
    expect(result.source.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(result.variants.map((v) => v.name)).toEqual([
      "small",
      "medium",
      "large",
    ]);
    for (const variant of result.variants) {
      const meta = await sharp(variant.body).metadata();
      expect(meta.format).toBe("webp");
      expect(variant.bytes).toBeGreaterThan(0);
    }
  });

  it("preserves aspect ratio in every variant", async () => {
    const result = await processUploadedImage(await photo(2000, 1000));
    for (const variant of result.variants) {
      expect(variant.width / variant.height).toBeCloseTo(2, 1);
    }
  });

  it("accepts PNG and WebP sources too", async () => {
    const png = await sharp({
      create: { width: 900, height: 700, channels: 3, background: "#444" },
    })
      .png()
      .toBuffer();
    const webp = await sharp({
      create: { width: 900, height: 700, channels: 3, background: "#444" },
    })
      .webp()
      .toBuffer();

    expect((await processUploadedImage(png)).source.format).toBe("png");
    expect((await processUploadedImage(webp)).source.format).toBe("webp");
  });

  describe("metadata", () => {
    it("strips EXIF, including GPS, from every published variant", async () => {
      const withExif = await photoWithExif(1200, 900);
      // The fixture really does carry what we claim to remove, or this
      // test would pass against an image that never had EXIF at all.
      expect((await sharp(withExif).metadata()).exif).toBeInstanceOf(Buffer);

      const result = await processUploadedImage(withExif);

      for (const variant of result.variants) {
        const meta = await sharp(variant.body).metadata();
        expect(meta.exif).toBeUndefined();
        expect(meta.xmp).toBeUndefined();
        expect(meta.iptc).toBeUndefined();
      }
    });

    it("leaves no trace of the camera make or GPS bytes in the output", async () => {
      const result = await processUploadedImage(await photoWithExif(1200, 900));
      for (const variant of result.variants) {
        const haystack = variant.body.toString("latin1");
        expect(haystack).not.toContain("Privacy Leak 9000");
        expect(haystack).not.toContain("TestCam");
        expect(haystack).not.toContain("GPSLatitude");
      }
    });

    it("applies EXIF orientation to the pixels before discarding the tag", async () => {
      // Orientation 6 means "rotate 90 clockwise on display", so a stored
      // 1200x900 is really a 900x1200 portrait photo.
      const rotated = await photoWithExif(1200, 900, 6);
      const result = await processUploadedImage(rotated);

      expect(result.source.width).toBe(900);
      expect(result.source.height).toBe(1200);
      for (const variant of result.variants) {
        expect(variant.height).toBeGreaterThan(variant.width);
        expect((await sharp(variant.body).metadata()).exif).toBeUndefined();
      }
    });
  });

  describe("refusals", () => {
    it("refuses bytes that are not an image", async () => {
      await expect(
        processUploadedImage(Buffer.from("not an image at all")),
      ).rejects.toMatchObject({ code: "UNREADABLE" });
    });

    it("refuses a truncated image rather than rendering the part that parsed", async () => {
      const whole = await photo(1200, 900);
      await expect(
        processUploadedImage(whole.subarray(0, Math.floor(whole.length / 3))),
      ).rejects.toBeInstanceOf(ImageRejected);
    });

    it("refuses a file above the byte ceiling before decoding it", async () => {
      const oversized = Buffer.alloc(LIMITS.maxBytes + 1);
      await expect(processUploadedImage(oversized)).rejects.toMatchObject({
        code: "TOO_LARGE",
      });
    });

    it("refuses a format we do not publish, however well libvips decodes it", async () => {
      const tiff = await sharp({
        create: { width: 800, height: 600, channels: 3, background: "#123456" },
      })
        .tiff()
        .toBuffer();
      await expect(processUploadedImage(tiff)).rejects.toMatchObject({
        code: "UNSUPPORTED_FORMAT",
      });
    });

    it("refuses an image too small to be worth publishing", async () => {
      await expect(
        processUploadedImage(await photo(150, 150)),
      ).rejects.toMatchObject({ code: "TOO_SMALL" });
    });

    it("refuses a decompression bomb during decode, not after allocating it", async () => {
      // A PNG of flat colour compresses to almost nothing, so this is a
      // small file that claims an enormous canvas — the classic shape.
      const bomb = await sharp({
        create: {
          width: 9000,
          height: 9000,
          channels: 3,
          background: "#000000",
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();

      expect(bomb.byteLength).toBeLessThan(LIMITS.maxBytes);
      expect(9000 * 9000).toBeGreaterThan(LIMITS.maxPixels);

      await expect(processUploadedImage(bomb)).rejects.toBeInstanceOf(
        ImageRejected,
      );
    });
  });
});
