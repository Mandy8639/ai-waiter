// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  PUBLISHED_CACHE_CONTROL,
  authorizeUpload,
  bucketForVariants,
  processUpload,
  publishImage,
  type ImageRecords,
  type StorageGateway,
} from "@/lib/menu-images/upload-core";
import {
  PRIVATE_BUCKET,
  PUBLISHED_BUCKET,
  isPubliclyResolvable,
  variantBucket,
  type ImageStatus,
} from "@/lib/menu-images/paths";

/**
 * The gateways are stubbed because they are Supabase; the behaviour being
 * tested — which path a credential is bound to, what happens to Storage and
 * the database when processing fails — is entirely this module's own. The
 * image bytes are real, and the database's identical path rules are covered
 * in tests/integration/db/menu-item-images.test.ts.
 */

const RESTAURANT = "11111111-1111-4111-8111-111111111111";
const DISH = "22222222-2222-4222-8222-222222222222";
const IMAGE = "33333333-3333-4333-8333-333333333333";
const OTHER_DISH = "44444444-4444-4444-8444-444444444444";

async function jpeg(width = 1200, height = 900): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: "#c87840" },
  })
    .jpeg()
    .toBuffer();
}

function storageStub(overrides: Partial<StorageGateway> = {}): StorageGateway {
  return {
    createSignedUploadUrl: vi.fn(async (bucket: string, path: string) => ({
      signedUrl: `https://storage.test/${bucket}/${path}?token=t`,
      token: "t",
    })),
    download: vi.fn(async () => jpeg()),
    upload: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    ...overrides,
  };
}

const VARIANT_KEYS = {
  small: `${RESTAURANT}/${DISH}/${IMAGE}/small.webp`,
  medium: `${RESTAURANT}/${DISH}/${IMAGE}/medium.webp`,
  large: `${RESTAURANT}/${DISH}/${IMAGE}/large.webp`,
};

function recordsStub(overrides: Partial<ImageRecords> = {}): ImageRecords {
  return {
    beginUpload: vi.fn(async () => IMAGE),
    load: vi.fn(async () => ({
      restaurantId: RESTAURANT,
      menuItemId: DISH,
      status: "uploading" as ImageStatus,
      variantPaths: null,
    })),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    ...overrides,
  };
}

/** A record that has finished processing and is waiting for an owner. */
function pendingReviewRecords(overrides: Partial<ImageRecords> = {}) {
  return recordsStub({
    load: vi.fn(async () => ({
      restaurantId: RESTAURANT,
      menuItemId: DISH,
      status: "pending_review" as ImageStatus,
      variantPaths: VARIANT_KEYS,
    })),
    ...overrides,
  });
}

describe("authorizeUpload", () => {
  it("binds the credential to one path built from database-supplied ids", async () => {
    const storage = storageStub();
    const result = await authorizeUpload(
      { restaurantId: RESTAURANT, menuItemId: DISH, contentType: "image/jpeg" },
      { records: recordsStub(), storage },
    );

    expect(result.path).toBe(`${RESTAURANT}/${DISH}/${IMAGE}/original.jpg`);
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(
      PRIVATE_BUCKET,
      result.path,
    );
  });

  it("uses the image id the database minted, never one supplied by a caller", async () => {
    // The only id a client controls is the dish; the image id is created
    // inside begin_menu_item_image_upload() after it re-checks the caller.
    const records = recordsStub({ beginUpload: vi.fn(async () => IMAGE) });
    const result = await authorizeUpload(
      { restaurantId: RESTAURANT, menuItemId: DISH, contentType: "image/png" },
      { records, storage: storageStub() },
    );

    expect(records.beginUpload).toHaveBeenCalledWith(DISH);
    expect(result.imageId).toBe(IMAGE);
    expect(result.path).toContain(`/${IMAGE}/`);
  });

  it("cannot be steered at another dish: the path follows the id it was given", async () => {
    const storage = storageStub();
    await authorizeUpload(
      {
        restaurantId: RESTAURANT,
        menuItemId: OTHER_DISH,
        contentType: "image/jpeg",
      },
      { records: recordsStub(), storage },
    );
    const [, path] = (storage.createSignedUploadUrl as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(path).toBe(`${RESTAURANT}/${OTHER_DISH}/${IMAGE}/original.jpg`);
    expect(path).not.toContain(DISH);
  });

  it("refuses a content type we do not accept, before creating any record", async () => {
    const records = recordsStub();
    await expect(
      authorizeUpload(
        {
          restaurantId: RESTAURANT,
          menuItemId: DISH,
          contentType: "image/gif",
        },
        { records, storage: storageStub() },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(records.beginUpload).not.toHaveBeenCalled();
  });

  it("refuses ids that are not uuids, so a path segment cannot be smuggled", async () => {
    await expect(
      authorizeUpload(
        {
          restaurantId: `${RESTAURANT}/../../other`,
          menuItemId: DISH,
          contentType: "image/jpeg",
        },
        { records: recordsStub(), storage: storageStub() },
      ),
    ).rejects.toThrow(/not a uuid/);
  });
});

describe("PUBLISHED_CACHE_CONTROL", () => {
  /**
   * Regression: this was once the full directive string, which Supabase
   * nested into `public, max-age=public, max-age=31536000, immutable`. The
   * value must stay a bare number of seconds, because the header is the
   * server's to build.
   */
  it("is a bare number of seconds, never a directive", () => {
    expect(PUBLISHED_CACHE_CONTROL).toMatch(/^\d+$/);
  });

  it("asks for a year", () => {
    expect(Number(PUBLISHED_CACHE_CONTROL)).toBe(365 * 24 * 60 * 60);
  });
});

describe("processUpload", () => {
  it("writes every variant to the PRIVATE bucket, not the public one", async () => {
    const storage = storageStub();
    const records = recordsStub();
    const result = await processUpload(IMAGE, { records, storage });

    const uploads = (storage.upload as ReturnType<typeof vi.fn>).mock.calls;
    // 1200px source: small 400, medium 800, large capped at 1200 (never upscaled).
    expect(uploads.map((c) => c[1])).toEqual([
      `${RESTAURANT}/${DISH}/${IMAGE}/small.webp`,
      `${RESTAURANT}/${DISH}/${IMAGE}/medium.webp`,
      `${RESTAURANT}/${DISH}/${IMAGE}/large.webp`,
    ]);
    for (const call of uploads) {
      // The heart of the fix: finishing processing is not approval.
      expect(call[0]).toBe(PRIVATE_BUCKET);
      expect(call[3]).toMatchObject({
        contentType: "image/webp",
        cacheControl: PUBLISHED_CACHE_CONTROL,
      });
    }
    expect(Object.keys(result.variantPaths)).toEqual([
      "small",
      "medium",
      "large",
    ]);
  });

  it("records the decoded facts, not the client's claims", async () => {
    const records = recordsStub();
    await processUpload(IMAGE, { records, storage: storageStub() });

    expect(records.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        imageId: IMAGE,
        originalPath: `${RESTAURANT}/${DISH}/${IMAGE}/original.jpg`,
        width: 1200,
        height: 900,
        mimeType: "image/jpeg",
        contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
  });

  it("never activates anything: it only completes the record", async () => {
    // Phase 1's publish_menu_item_image() is the only way an image becomes
    // active, and this module must not be a second route to it.
    const records = recordsStub();
    const storage = storageStub();
    await processUpload(IMAGE, { records, storage });

    expect(records.publish).not.toHaveBeenCalled();
    // And nothing was copied into public storage either.
    expect(storage.copy).not.toHaveBeenCalled();
  });

  describe("failure", () => {
    it("marks the image failed and leaves the active photo untouched", async () => {
      const records = recordsStub();
      const storage = storageStub({
        download: vi.fn(async () => Buffer.from("not an image")),
      });

      await expect(
        processUpload(IMAGE, { records, storage }),
      ).rejects.toMatchObject({ code: "UNREADABLE" });

      expect(records.fail).toHaveBeenCalledWith(
        IMAGE,
        "That file could not be read as an image.",
      );
      expect(records.complete).not.toHaveBeenCalled();
    });

    it("removes variants already written, so no orphan outlives the failure", async () => {
      const records = recordsStub({
        complete: vi.fn(async () => {
          throw new Error("database said no");
        }),
      });
      const storage = storageStub();

      await expect(processUpload(IMAGE, { records, storage })).rejects.toThrow(
        "database said no",
      );

      expect(storage.remove).toHaveBeenCalledWith(PRIVATE_BUCKET, [
        VARIANT_KEYS.small,
        VARIANT_KEYS.medium,
        VARIANT_KEYS.large,
      ]);
      expect(records.fail).toHaveBeenCalled();
    });

    it("never claims variants exist when the upload of one failed", async () => {
      let calls = 0;
      const storage = storageStub({
        upload: vi.fn(async () => {
          calls += 1;
          if (calls === 2) throw new Error("storage went away");
        }),
      });
      const records = recordsStub();

      await expect(processUpload(IMAGE, { records, storage })).rejects.toThrow(
        "storage went away",
      );
      expect(records.complete).not.toHaveBeenCalled();
      // The one that did land is cleaned up.
      expect(storage.remove).toHaveBeenCalledWith(PRIVATE_BUCKET, [
        VARIANT_KEYS.small,
      ]);
    });

    it("keeps the original for a retry rather than deleting the evidence", async () => {
      const storage = storageStub({
        download: vi.fn(async () => Buffer.from("not an image")),
      });
      await expect(
        processUpload(IMAGE, { records: recordsStub(), storage }),
      ).rejects.toThrow();

      // Nothing was ever made public, and the original is kept for a retry.
      const removals = (storage.remove as ReturnType<typeof vi.fn>).mock.calls;
      for (const [bucket, paths] of removals) {
        expect(bucket).not.toBe(PUBLISHED_BUCKET);
        expect(paths).not.toContain(
          `${RESTAURANT}/${DISH}/${IMAGE}/original.jpg`,
        );
      }
    });

    it("refuses an image whose upload never arrived", async () => {
      const storage = storageStub({
        download: vi.fn(async () => {
          throw new Error("404");
        }),
      });
      const records = recordsStub();

      await expect(processUpload(IMAGE, { records, storage })).rejects.toThrow(
        /never finished uploading/,
      );
      expect(records.fail).toHaveBeenCalled();
    });

    it("refuses to reprocess an image that is not awaiting an upload", async () => {
      const records = recordsStub({
        load: vi.fn(async () => ({
          restaurantId: RESTAURANT,
          menuItemId: DISH,
          status: "active" as ImageStatus,
          variantPaths: VARIANT_KEYS,
        })),
      });
      await expect(
        processUpload(IMAGE, { records, storage: storageStub() }),
      ).rejects.toThrow(/already been processed/);
    });

    it("refuses an image the caller cannot see", async () => {
      // load() goes through RLS, so another restaurant's image is simply
      // absent rather than forbidden.
      const records = recordsStub({ load: vi.fn(async () => null) });
      const storage = storageStub();
      await expect(processUpload(IMAGE, { records, storage })).rejects.toThrow(
        /could not be found/,
      );
      expect(storage.download).not.toHaveBeenCalled();
    });
  });
});

/**
 * Publication — the only route by which bytes become publicly readable.
 *
 * The invariant these protect:
 *   PRIVATE STORAGE = source + processing + review
 *   PUBLIC STORAGE  = explicitly published sanitized derivatives only
 */
describe("publishImage", () => {
  it("copies every processed variant into the public bucket", async () => {
    const storage = storageStub();
    const records = pendingReviewRecords();

    const result = await publishImage(IMAGE, { records, storage });

    const copies = (storage.copy as ReturnType<typeof vi.fn>).mock.calls;
    expect(copies.map((c) => [c[0], c[1], c[2], c[3]])).toEqual([
      [
        PRIVATE_BUCKET,
        VARIANT_KEYS.small,
        PUBLISHED_BUCKET,
        VARIANT_KEYS.small,
      ],
      [
        PRIVATE_BUCKET,
        VARIANT_KEYS.medium,
        PUBLISHED_BUCKET,
        VARIANT_KEYS.medium,
      ],
      [
        PRIVATE_BUCKET,
        VARIANT_KEYS.large,
        PUBLISHED_BUCKET,
        VARIANT_KEYS.large,
      ],
    ]);
    expect(result.publishedPaths).toHaveLength(3);
  });

  it("activates the image only after every copy has succeeded", async () => {
    const order: string[] = [];
    const storage = storageStub({
      copy: vi.fn(async () => {
        order.push("copy");
      }),
    });
    const records = pendingReviewRecords({
      publish: vi.fn(async () => {
        order.push("publish");
      }),
    });

    await publishImage(IMAGE, { records, storage });

    expect(order).toEqual(["copy", "copy", "copy", "publish"]);
  });

  it("copies rather than re-encodes, so the public bytes are the sanitized ones", async () => {
    const storage = storageStub();
    await publishImage(IMAGE, { records: pendingReviewRecords(), storage });
    // A re-upload would mean a second encoding, and a second chance to get
    // metadata stripping wrong.
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("refuses an image that has not been reviewed", async () => {
    for (const status of [
      "uploading",
      "generating",
      "active",
      "rejected",
      "failed",
    ] as ImageStatus[]) {
      const storage = storageStub();
      const records = pendingReviewRecords({
        load: vi.fn(async () => ({
          restaurantId: RESTAURANT,
          menuItemId: DISH,
          status,
          variantPaths: VARIANT_KEYS,
        })),
      });

      await expect(publishImage(IMAGE, { records, storage })).rejects.toThrow(
        /not waiting to be published/,
      );
      expect(storage.copy).not.toHaveBeenCalled();
      expect(records.publish).not.toHaveBeenCalled();
    }
  });

  it("refuses to publish an image with no processed variants", async () => {
    const storage = storageStub();
    const records = pendingReviewRecords({
      load: vi.fn(async () => ({
        restaurantId: RESTAURANT,
        menuItemId: DISH,
        status: "pending_review" as ImageStatus,
        variantPaths: null,
      })),
    });

    await expect(publishImage(IMAGE, { records, storage })).rejects.toThrow(
      /no processed variants/,
    );
    expect(records.publish).not.toHaveBeenCalled();
  });

  it("refuses a variant key outside this image's own folder", async () => {
    const storage = storageStub();
    const records = pendingReviewRecords({
      load: vi.fn(async () => ({
        restaurantId: RESTAURANT,
        menuItemId: DISH,
        status: "pending_review" as ImageStatus,
        variantPaths: {
          small: `${RESTAURANT}/${OTHER_DISH}/${IMAGE}/small.webp`,
        },
      })),
    });

    await expect(publishImage(IMAGE, { records, storage })).rejects.toThrow(
      /could not be published/,
    );
    expect(storage.copy).not.toHaveBeenCalled();
    expect(records.publish).not.toHaveBeenCalled();
  });

  describe("a copy fails part-way", () => {
    function failingOnThirdCopy() {
      let calls = 0;
      return storageStub({
        copy: vi.fn(async () => {
          calls += 1;
          if (calls === 3) throw new Error("storage refused the copy");
        }),
      });
    }

    it("does not activate the image", async () => {
      const storage = failingOnThirdCopy();
      const records = pendingReviewRecords();

      await expect(publishImage(IMAGE, { records, storage })).rejects.toThrow(
        "storage refused the copy",
      );
      expect(records.publish).not.toHaveBeenCalled();
    });

    it("removes the public objects it had already created", async () => {
      const storage = failingOnThirdCopy();
      await expect(
        publishImage(IMAGE, { records: pendingReviewRecords(), storage }),
      ).rejects.toThrow();

      expect(storage.remove).toHaveBeenCalledWith(PUBLISHED_BUCKET, [
        VARIANT_KEYS.small,
        VARIANT_KEYS.medium,
      ]);
    });

    it("leaves the private variants alone, so it can be published again", async () => {
      const storage = failingOnThirdCopy();
      await expect(
        publishImage(IMAGE, { records: pendingReviewRecords(), storage }),
      ).rejects.toThrow();

      const removals = (storage.remove as ReturnType<typeof vi.fn>).mock.calls;
      for (const [bucket] of removals) {
        expect(bucket).not.toBe(PRIVATE_BUCKET);
      }
    });
  });

  describe("the database publish fails after the copies succeeded", () => {
    it("removes the newly public objects and does not activate", async () => {
      const storage = storageStub();
      const records = pendingReviewRecords({
        publish: vi.fn(async () => {
          throw new Error("publish_menu_item_image failed");
        }),
      });

      await expect(publishImage(IMAGE, { records, storage })).rejects.toThrow(
        "publish_menu_item_image failed",
      );

      expect(storage.remove).toHaveBeenCalledWith(PUBLISHED_BUCKET, [
        VARIANT_KEYS.small,
        VARIANT_KEYS.medium,
        VARIANT_KEYS.large,
      ]);
    });

    it("leaves the previously active image untouched", async () => {
      // The old image is stepped down inside publish_menu_item_image(), in
      // the same statement that activates the new one. If that call fails,
      // nothing about the old image changed — there is no separate
      // step-down this module could have performed early.
      const records = pendingReviewRecords({
        publish: vi.fn(async () => {
          throw new Error("publish failed");
        }),
      });

      await expect(
        publishImage(IMAGE, { records, storage: storageStub() }),
      ).rejects.toThrow();

      expect(Object.keys(records)).not.toContain("supersede");
      expect(records.complete).not.toHaveBeenCalled();
    });
  });
});

describe("bucket selection", () => {
  it("keeps unreviewed and rejected images entirely private", () => {
    for (const status of [
      "uploading",
      "generating",
      "pending_review",
      "rejected",
      "failed",
    ] as ImageStatus[]) {
      expect(variantBucket(status)).toBe(PRIVATE_BUCKET);
      expect(bucketForVariants(status)).toBe(PRIVATE_BUCKET);
    }
  });

  it("serves published copies for images that reached active", () => {
    // superseded and removed are reachable only from active, and keep
    // their public objects through the 30-day retention window so a
    // replacement never breaks a URL a browser is still holding.
    for (const status of ["active", "superseded", "removed"] as ImageStatus[]) {
      expect(variantBucket(status)).toBe(PUBLISHED_BUCKET);
    }
  });

  it("resolves a diner-facing URL only for the active image", () => {
    expect(isPubliclyResolvable("active")).toBe(true);
    for (const status of [
      "uploading",
      "generating",
      "pending_review",
      "rejected",
      "failed",
      "superseded",
      "removed",
    ] as ImageStatus[]) {
      expect(isPubliclyResolvable(status)).toBe(false);
    }
  });

  it("derives the bucket from status alone, never from client input", async () => {
    // processUpload and publishImage take an image id and nothing else that
    // could name a bucket; the gateway is told which bucket by this module.
    const storage = storageStub();
    await processUpload(IMAGE, { records: recordsStub(), storage });
    const buckets = (storage.upload as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    expect(new Set(buckets)).toEqual(new Set([PRIVATE_BUCKET]));
  });
});

describe("source type does not change the lifecycle", () => {
  it("treats a real photo and a future AI generation identically", async () => {
    // The storage layer never reads `source`. An AI image will reach
    // pending_review the same way and must be published the same way, so
    // there is no path that writes generated bytes straight to public
    // storage.
    const storage = storageStub();
    await publishImage(IMAGE, { records: pendingReviewRecords(), storage });

    const copies = (storage.copy as ReturnType<typeof vi.fn>).mock.calls;
    expect(copies).toHaveLength(3);
    // Nothing in this module branches on source at all.
    const source = (await import("node:fs")).readFileSync(
      "src/lib/menu-images/upload-core.ts",
      "utf8",
    );
    expect(source).not.toMatch(/\bai_generated\b/);
    expect(source).not.toMatch(/source\s*===/);
  });
});
