// @vitest-environment node
//
// Phase 4B: the restaurant hero video.
//
// The container check is tested with real header bytes rather than a
// mocked "isVideo" helper, because the whole point of that module is that
// it is the only thing standing between an owner's upload and a publicly
// served object — there is no ffmpeg to decode the file, so if the sniffer
// is wrong, nothing else catches it.
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  HEADER_BYTES,
  VIDEO_LIMITS,
  VideoRejected,
  checkVideoSize,
  detectContainer,
} from "@/lib/hero-video/container";
import {
  VIDEO_PRIVATE_BUCKET,
  VIDEO_PUBLISHED_BUCKET,
  heroVideoBucket,
  heroVideoPath,
  heroVideoPrefix,
  isHeroVideoPublic,
  posterVariantPath,
} from "@/lib/hero-video/paths";
import {
  authorizeHeroUpload,
  processHeroUpload,
  publishHeroVideo,
  type HeroStorageGateway,
  type HeroVideoRecords,
} from "@/lib/hero-video/upload-core";
import { resolveHeroVideo } from "@/lib/hero-video/resolve";
import { ImageRejected } from "@/lib/menu-images/processing";

const RESTAURANT = "11111111-1111-4111-8111-111111111111";
const VIDEO = "22222222-2222-4222-8222-222222222222";
const SUPABASE = "https://example.supabase.co";

// --------------------------------------------------------------------------
// Container detection
// --------------------------------------------------------------------------

/** An ISO base media header: 4 size bytes, "ftyp", then the major brand. */
function mp4Header(brand = "isom", compatible: string[] = []): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  head.writeUInt32BE(16 + compatible.length * 4, 0);
  head.write("ftyp", 4, "latin1");
  head.write(brand, 8, "latin1");
  head.writeUInt32BE(512, 12); // minor version
  compatible.forEach((c, i) => head.write(c, 16 + i * 4, "latin1"));
  return head;
}

function webmHeader(): Buffer {
  const head = Buffer.alloc(HEADER_BYTES);
  head.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  head.write("webm", 31, "latin1");
  return head;
}

describe("detectContainer", () => {
  it("recognises a plain MP4", () => {
    expect(detectContainer(mp4Header("isom"), "video/mp4")).toBe("video/mp4");
  });

  it("recognises WebM by its EBML magic", () => {
    expect(detectContainer(webmHeader(), "video/webm")).toBe("video/webm");
  });

  it("accepts a familiar brand found in the compatible list", () => {
    // Some encoders write an unfamiliar major brand and list the real ones
    // after it.
    const header = mp4Header("XAVC", ["isom", "mp42"]);
    expect(detectContainer(header, "video/mp4")).toBe("video/mp4");
  });

  it("refuses a QuickTime .mov, however common it is on an iPhone", () => {
    // Deliberate: Safari plays it, Chrome's support depends on the codec
    // inside, and a hero that works for the owner and not for half their
    // diners is the worst outcome — nobody reports it.
    const error = catchError(() =>
      detectContainer(mp4Header("qt  "), "video/mp4"),
    );
    expect(error).toBeInstanceOf(VideoRejected);
    expect((error as VideoRejected).code).toBe("UNSUPPORTED_CONTAINER");
  });

  it("refuses an HTML error page that was saved as a video", () => {
    const html = Buffer.alloc(HEADER_BYTES);
    html.write(
      "<!DOCTYPE html><html><head><title>502 Bad Gateway",
      0,
      "latin1",
    );
    expect(() => detectContainer(html, "video/mp4")).toThrow(VideoRejected);
  });

  it("refuses a JPEG renamed to .mp4", () => {
    const jpeg = Buffer.alloc(HEADER_BYTES);
    jpeg.set([0xff, 0xd8, 0xff, 0xe0], 0);
    expect(() => detectContainer(jpeg, "video/mp4")).toThrow(VideoRejected);
  });

  it("refuses a ZIP, which is what an .exe in disguise usually is", () => {
    const zip = Buffer.alloc(HEADER_BYTES);
    zip.write("PK\u0003\u0004", 0, "latin1");
    expect(() => detectContainer(zip, "video/mp4")).toThrow(VideoRejected);
  });

  it("refuses bytes that are a real video of the WRONG declared type", () => {
    // A .webm renamed .mp4 would otherwise be stored under a Content-Type
    // it cannot play as.
    const error = catchError(() => detectContainer(webmHeader(), "video/mp4"));
    expect((error as VideoRejected).message).toMatch(/don't match its type/);
  });

  it("refuses a file too short to contain a header", () => {
    expect(() => detectContainer(Buffer.alloc(8), "video/mp4")).toThrow(
      VideoRejected,
    );
  });
});

describe("checkVideoSize", () => {
  it("refuses a file over the bucket's own ceiling", () => {
    const error = catchError(() => checkVideoSize(VIDEO_LIMITS.maxBytes + 1));
    expect((error as VideoRejected).code).toBe("TOO_LARGE");
  });

  it("refuses a file too small to be a real recording", () => {
    const error = catchError(() => checkVideoSize(512));
    expect((error as VideoRejected).code).toBe("TOO_SMALL");
  });

  it("accepts an ordinary hero clip", () => {
    expect(() => checkVideoSize(6 * 1024 * 1024)).not.toThrow();
  });
});

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

describe("hero video paths", () => {
  it("puts every object in the video's own folder, one level above a dish photo", () => {
    expect(heroVideoPrefix({ restaurantId: RESTAURANT, videoId: VIDEO })).toBe(
      `${RESTAURANT}/${VIDEO}/`,
    );
  });

  it("refuses an identity that is not a pair of uuids", () => {
    expect(() =>
      heroVideoPrefix({ restaurantId: "../etc", videoId: VIDEO }),
    ).toThrow(/not a uuid/);
  });

  it("names the video by its container", () => {
    expect(
      heroVideoPath({ restaurantId: RESTAURANT, videoId: VIDEO }, "webm"),
    ).toBe(`${RESTAURANT}/${VIDEO}/original.webm`);
  });

  it("refuses a poster variant name that would escape the folder", () => {
    expect(() =>
      posterVariantPath({ restaurantId: RESTAURANT, videoId: VIDEO }, "../x"),
    ).toThrow(/not a usable variant name/);
  });

  it("only ever treats 'active' as publicly resolvable", () => {
    expect(isHeroVideoPublic("active")).toBe(true);
    for (const status of [
      "uploading",
      "pending_review",
      "superseded",
      "rejected",
      "removed",
      "failed",
    ] as const) {
      expect(isHeroVideoPublic(status)).toBe(false);
    }
  });

  it("keeps superseded and removed objects on the public side, where they were copied", () => {
    // They are still in caches and open tabs; the pointer is what was
    // cleared, not the bytes.
    expect(heroVideoBucket("superseded")).toBe(VIDEO_PUBLISHED_BUCKET);
    expect(heroVideoBucket("removed")).toBe(VIDEO_PUBLISHED_BUCKET);
    expect(heroVideoBucket("pending_review")).toBe(VIDEO_PRIVATE_BUCKET);
    expect(heroVideoBucket("rejected")).toBe(VIDEO_PRIVATE_BUCKET);
  });
});

// --------------------------------------------------------------------------
// Upload, processing and publication
// --------------------------------------------------------------------------

async function poster(width = 1600, height = 900): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } },
  })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function recordsStub(
  overrides: Partial<HeroVideoRecords> = {},
): HeroVideoRecords {
  return {
    beginUpload: vi.fn(async () => VIDEO),
    load: vi.fn(async () => ({
      restaurantId: RESTAURANT,
      status: "uploading",
      videoPath: null,
      posterPaths: null,
    })),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    ...overrides,
  };
}

function storageStub(
  posterBytes: Buffer,
  overrides: Partial<HeroStorageGateway> = {},
): HeroStorageGateway {
  return {
    createSignedUploadUrl: vi.fn(async (_b: string, path: string) => ({
      signedUrl: `https://example.test/${path}`,
      token: `token-for-${path}`,
    })),
    download: vi.fn(async (_b: string, path: string) => {
      if (path.endsWith("poster-original.jpg")) return posterBytes;
      throw new Error("not found");
    }),
    downloadHead: vi.fn(async () => mp4Header("isom")),
    stat: vi.fn(async (_b: string, path: string) =>
      path.endsWith("original.mp4")
        ? { sizeBytes: 6 * 1024 * 1024, contentType: "video/mp4" }
        : null,
    ),
    upload: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("authorizeHeroUpload", () => {
  it("issues one token per file, each bound to its own path", async () => {
    const result = await authorizeHeroUpload(
      {
        restaurantId: RESTAURANT,
        videoContentType: "video/mp4",
        posterContentType: "image/jpeg",
      },
      { records: recordsStub(), storage: storageStub(await poster()) },
    );

    expect(result.video.path).toBe(`${RESTAURANT}/${VIDEO}/original.mp4`);
    expect(result.poster.path).toBe(
      `${RESTAURANT}/${VIDEO}/poster-original.jpg`,
    );
    expect(result.video.token).not.toBe(result.poster.token);
  });

  it("refuses a container the player cannot be relied on to open", async () => {
    await expect(
      authorizeHeroUpload(
        {
          restaurantId: RESTAURANT,
          videoContentType: "video/quicktime",
          posterContentType: "image/jpeg",
        },
        { records: recordsStub(), storage: storageStub(await poster()) },
      ),
    ).rejects.toBeInstanceOf(VideoRejected);
  });

  it("refuses a poster that is not an image, before reserving anything", async () => {
    const records = recordsStub();
    await expect(
      authorizeHeroUpload(
        {
          restaurantId: RESTAURANT,
          videoContentType: "video/mp4",
          posterContentType: "application/pdf",
        },
        { records, storage: storageStub(await poster()) },
      ),
    ).rejects.toBeInstanceOf(ImageRejected);
    expect(records.beginUpload).not.toHaveBeenCalled();
  });
});

describe("processHeroUpload", () => {
  it("writes poster variants privately and stops at pending_review", async () => {
    const storage = storageStub(await poster());
    const records = recordsStub();

    const result = await processHeroUpload(VIDEO, { records, storage });

    for (const call of (storage.upload as ReturnType<typeof vi.fn>).mock
      .calls) {
      expect(call[0]).toBe(VIDEO_PRIVATE_BUCKET);
    }
    expect(Object.keys(result.posterPaths).sort()).toEqual(["large", "small"]);

    const completed = (records.complete as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(completed.mimeType).toBe("video/mp4");
    expect(completed.byteSize).toBe(6 * 1024 * 1024);
    // Deliberately not hashed: see upload-core's header.
    expect(completed.contentSha256).toBeNull();
  });

  it("reads only the header, never the whole video", async () => {
    const storage = storageStub(await poster());
    await processHeroUpload(VIDEO, { records: recordsStub(), storage });

    expect(storage.downloadHead).toHaveBeenCalledWith(
      VIDEO_PRIVATE_BUCKET,
      `${RESTAURANT}/${VIDEO}/original.mp4`,
      HEADER_BYTES,
    );
    // The only full download is the poster.
    for (const call of (storage.download as ReturnType<typeof vi.fn>).mock
      .calls) {
      expect(call[1]).toContain("poster-original");
    }
  });

  it("takes the size from Storage, not from whatever the browser claimed", async () => {
    const storage = storageStub(await poster(), {
      stat: vi.fn(async (_b: string, path: string) =>
        path.endsWith("original.mp4")
          ? { sizeBytes: VIDEO_LIMITS.maxBytes + 1, contentType: "video/mp4" }
          : null,
      ),
    });
    const records = recordsStub();

    await expect(
      processHeroUpload(VIDEO, { records, storage }),
    ).rejects.toBeInstanceOf(VideoRejected);
    expect(records.fail).toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it("fails the row when the bytes are not a video at all", async () => {
    const notAVideo = Buffer.alloc(HEADER_BYTES);
    notAVideo.write("<!DOCTYPE html>", 0, "latin1");
    const storage = storageStub(await poster(), {
      downloadHead: vi.fn(async () => notAVideo),
    });
    const records = recordsStub();

    await expect(
      processHeroUpload(VIDEO, { records, storage }),
    ).rejects.toBeInstanceOf(VideoRejected);
    expect(records.fail).toHaveBeenCalledWith(
      VIDEO,
      "That file doesn't look like an MP4 or WebM video.",
    );
  });

  it("removes the poster variants it wrote if a later step throws", async () => {
    let uploads = 0;
    const storage = storageStub(await poster(), {
      upload: vi.fn(async () => {
        uploads += 1;
        if (uploads === 2) throw new Error("storage went away");
      }),
    });
    const records = recordsStub();

    await expect(
      processHeroUpload(VIDEO, { records, storage }),
    ).rejects.toThrow("storage went away");

    const removed = (storage.remove as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(removed[0]).toBe(VIDEO_PRIVATE_BUCKET);
    expect(removed[1]).toHaveLength(1);
  });

  it("refuses to process a row that is not still uploading", async () => {
    const records = recordsStub({
      load: vi.fn(async () => ({
        restaurantId: RESTAURANT,
        status: "active",
        videoPath: "x",
        posterPaths: {},
      })),
    });
    await expect(
      processHeroUpload(VIDEO, {
        records,
        storage: storageStub(await poster()),
      }),
    ).rejects.toThrow(/already been processed/);
  });
});

describe("publishHeroVideo", () => {
  const reviewed = {
    restaurantId: RESTAURANT,
    status: "pending_review",
    videoPath: `${RESTAURANT}/${VIDEO}/original.mp4`,
    posterPaths: {
      small: `${RESTAURANT}/${VIDEO}/poster-small.webp`,
      large: `${RESTAURANT}/${VIDEO}/poster-large.webp`,
    },
  };

  it("copies every object to the public bucket, verifies, then activates", async () => {
    const storage = storageStub(await poster(), {
      stat: vi.fn(async () => ({ sizeBytes: 1, contentType: "video/mp4" })),
    });
    const records = recordsStub({ load: vi.fn(async () => reviewed) });

    await publishHeroVideo(VIDEO, { records, storage });

    expect(storage.copy).toHaveBeenCalledTimes(3);
    for (const call of (storage.copy as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[0]).toBe(VIDEO_PRIVATE_BUCKET);
      expect(call[2]).toBe(VIDEO_PUBLISHED_BUCKET);
    }
    expect(records.publish).toHaveBeenCalledWith(VIDEO);
  });

  it("does not activate when a copy silently produced nothing", async () => {
    const storage = storageStub(await poster(), {
      stat: vi.fn(async () => null),
    });
    const records = recordsStub({ load: vi.fn(async () => reviewed) });

    await expect(
      publishHeroVideo(VIDEO, { records, storage }),
    ).rejects.toBeInstanceOf(VideoRejected);
    expect(records.publish).not.toHaveBeenCalled();
  });

  it("removes the public copies when publication fails", async () => {
    const storage = storageStub(await poster(), {
      stat: vi.fn(async () => null),
    });
    const records = recordsStub({ load: vi.fn(async () => reviewed) });

    await expect(
      publishHeroVideo(VIDEO, { records, storage }),
    ).rejects.toThrow();

    // Otherwise an unapproved video stays readable by anyone with the URL.
    const removed = (storage.remove as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(removed[0]).toBe(VIDEO_PUBLISHED_BUCKET);
    expect(removed[1]).toHaveLength(3);
  });

  it("refuses to publish anything that is not awaiting review", async () => {
    const records = recordsStub({
      load: vi.fn(async () => ({ ...reviewed, status: "rejected" })),
    });
    await expect(
      publishHeroVideo(VIDEO, {
        records,
        storage: storageStub(await poster()),
      }),
    ).rejects.toThrow(/no longer waiting for review/);
  });
});

// --------------------------------------------------------------------------
// What the diner gets
// --------------------------------------------------------------------------

describe("resolveHeroVideo", () => {
  const pointer = {
    video: `${RESTAURANT}/${VIDEO}/original.mp4`,
    poster: {
      small: `${RESTAURANT}/${VIDEO}/poster-small.webp`,
      large: `${RESTAURANT}/${VIDEO}/poster-large.webp`,
    },
  };

  it("returns null when the restaurant has no hero — the normal case", () => {
    expect(
      resolveHeroVideo({
        activeHeroVideoId: null,
        heroVideo: null,
        supabaseUrl: SUPABASE,
      }),
    ).toBeNull();
  });

  it("serves the video and a responsive poster from the public bucket", () => {
    const resolved = resolveHeroVideo({
      activeHeroVideoId: VIDEO,
      heroVideo: pointer,
      supabaseUrl: SUPABASE,
    })!;

    expect(resolved.src).toBe(
      `${SUPABASE}/storage/v1/object/public/restaurant-videos/${pointer.video}`,
    );
    expect(resolved.posterSrcSet).toContain("800w");
    expect(resolved.posterSrcSet).toContain("1600w");
    // The smallest still is the fallback, so a browser ignoring srcset on
    // a phone does not pull the 1600px file.
    expect(resolved.poster).toContain("poster-small.webp");
  });

  it("renders no hero when the pointer exists but the poster does not", () => {
    // A play button over a grey box is worse than no hero at all.
    expect(
      resolveHeroVideo({
        activeHeroVideoId: VIDEO,
        heroVideo: { video: pointer.video, poster: {} },
        supabaseUrl: SUPABASE,
      }),
    ).toBeNull();
  });

  it("ignores poster keys it does not recognise", () => {
    const resolved = resolveHeroVideo({
      activeHeroVideoId: VIDEO,
      heroVideo: {
        video: pointer.video,
        poster: { ...pointer.poster, enormous: "x/y/poster-enormous.webp" },
      },
      supabaseUrl: SUPABASE,
    })!;
    expect(resolved.posterSrcSet).not.toContain("enormous");
  });

  it("survives a malformed jsonb value rather than breaking the menu", () => {
    expect(
      resolveHeroVideo({
        activeHeroVideoId: VIDEO,
        heroVideo: { video: "", poster: pointer.poster },
        supabaseUrl: SUPABASE,
      }),
    ).toBeNull();
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}
