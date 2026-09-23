// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  ImportUploadRejected,
  MAX_PAGES,
  MENU_IMPORTS_BUCKET,
  authorizeImportUpload,
  importPagePath,
  isValidImportPagePath,
  loadImportPageDataUrls,
  type ImportRecords,
} from "@/lib/menu-import/upload-core";
import type { StorageGateway } from "@/lib/menu-images/upload-core";

/**
 * The defect this fixes was a transport one: photographs travelled as
 * base64 inside a server action capped at 1 MB. So the tests that matter
 * are about what crosses that boundary, and about a caller being unable to
 * aim extraction at an object it chose.
 *
 * Real image bytes throughout — a data URL built from a stub Buffer would
 * not prove the round trip produces something a vision model can read.
 */

const RESTAURANT = "11111111-1111-4111-8111-111111111111";
const OTHER_RESTAURANT = "99999999-9999-4999-8999-999999999999";

async function photo(label: number): Promise<Buffer> {
  return sharp({
    create: {
      width: 60,
      height: 40,
      channels: 3,
      background: { r: label * 20, g: 100, b: 100 },
    },
  })
    .jpeg()
    .toBuffer();
}

function storageStub(overrides: Partial<StorageGateway> = {}): StorageGateway {
  return {
    createSignedUploadUrl: vi.fn(async (bucket: string, p: string) => ({
      signedUrl: `https://storage.test/${bucket}/${p}?token=t`,
      token: `token-for-${p}`,
    })),
    download: vi.fn(async () => photo(1)),
    upload: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    ...overrides,
  };
}

function recordsStub(overrides: Partial<ImportRecords> = {}): ImportRecords {
  return {
    create: vi.fn(async () => {}),
    load: vi.fn(async () => null),
    ...overrides,
  };
}

describe("authorizeImportUpload", () => {
  it("mints one server-chosen path per page, in order", async () => {
    const storage = storageStub();
    const records = recordsStub();

    const result = await authorizeImportUpload(
      {
        restaurantId: RESTAURANT,
        contentTypes: ["image/jpeg", "image/png", "image/webp"],
      },
      { records, storage },
    );

    expect(result.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(result.pages.map((p) => p.path)).toEqual([
      `${RESTAURANT}/${result.importId}/page-1.jpg`,
      `${RESTAURANT}/${result.importId}/page-2.png`,
      `${RESTAURANT}/${result.importId}/page-3.webp`,
    ]);
    for (const page of result.pages) {
      expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(
        MENU_IMPORTS_BUCKET,
        page.path,
      );
    }
  });

  it("records the paths on the import row before any bytes exist", async () => {
    const records = recordsStub();
    const result = await authorizeImportUpload(
      { restaurantId: RESTAURANT, contentTypes: ["image/jpeg", "image/jpeg"] },
      { records, storage: storageStub() },
    );

    expect(records.create).toHaveBeenCalledWith({
      importId: result.importId,
      restaurantId: RESTAURANT,
      sourcePaths: [
        `${RESTAURANT}/${result.importId}/page-1.jpg`,
        `${RESTAURANT}/${result.importId}/page-2.jpg`,
      ],
    });
  });

  it("mints a fresh import id each time, so two imports never share a folder", async () => {
    const args = {
      restaurantId: RESTAURANT,
      contentTypes: ["image/jpeg"],
    };
    const deps = { records: recordsStub(), storage: storageStub() };
    const a = await authorizeImportUpload(args, deps);
    const b = await authorizeImportUpload(args, deps);
    expect(a.importId).not.toBe(b.importId);
  });

  it("allows the advertised eight pages and refuses a ninth", async () => {
    const deps = { records: recordsStub(), storage: storageStub() };
    const eight = Array(MAX_PAGES).fill("image/jpeg");

    await expect(
      authorizeImportUpload(
        { restaurantId: RESTAURANT, contentTypes: eight },
        deps,
      ),
    ).resolves.toMatchObject({ pages: expect.any(Array) });

    await expect(
      authorizeImportUpload(
        { restaurantId: RESTAURANT, contentTypes: [...eight, "image/jpeg"] },
        deps,
      ),
    ).rejects.toMatchObject({ code: "TOO_MANY_PAGES" });
  });

  it("refuses an empty selection", async () => {
    await expect(
      authorizeImportUpload(
        { restaurantId: RESTAURANT, contentTypes: [] },
        { records: recordsStub(), storage: storageStub() },
      ),
    ).rejects.toMatchObject({ code: "NO_PAGES" });
  });

  it("refuses a format the bucket does not accept, before creating the row", async () => {
    const records = recordsStub();
    await expect(
      authorizeImportUpload(
        { restaurantId: RESTAURANT, contentTypes: ["image/jpeg", "image/gif"] },
        { records, storage: storageStub() },
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    expect(records.create).not.toHaveBeenCalled();
  });

  it("refuses a restaurant id that is not a uuid, so no separator can be smuggled in", async () => {
    await expect(
      authorizeImportUpload(
        {
          restaurantId: `${RESTAURANT}/../${OTHER_RESTAURANT}`,
          contentTypes: ["image/jpeg"],
        },
        { records: recordsStub(), storage: storageStub() },
      ),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
});

describe("isValidImportPagePath", () => {
  const IMPORT = "22222222-2222-4222-8222-222222222222";

  it("accepts a page inside the import's own folder", () => {
    expect(
      isValidImportPagePath(
        importPagePath(RESTAURANT, IMPORT, 0, "jpg"),
        RESTAURANT,
        IMPORT,
      ),
    ).toBe(true);
  });

  it.each([
    `${RESTAURANT}/${IMPORT}/../../${OTHER_RESTAURANT}/page-1.jpg`,
    `${OTHER_RESTAURANT}/${IMPORT}/page-1.jpg`,
    `${RESTAURANT}/${IMPORT}/sub/page-1.jpg`,
    `${RESTAURANT}/${IMPORT}/..`,
    `/${RESTAURANT}/${IMPORT}/page-1.jpg`,
  ])("rejects %s", (path) => {
    expect(isValidImportPagePath(path, RESTAURANT, IMPORT)).toBe(false);
  });
});

describe("loadImportPageDataUrls", () => {
  const IMPORT = "22222222-2222-4222-8222-222222222222";

  function loadedRecords(overrides: Partial<ImportRecords> = {}) {
    return recordsStub({
      load: vi.fn(async () => ({
        restaurantId: RESTAURANT,
        status: "uploaded",
        sourcePaths: [
          `${RESTAURANT}/${IMPORT}/page-1.jpg`,
          `${RESTAURANT}/${IMPORT}/page-2.jpg`,
        ],
      })),
      ...overrides,
    });
  }

  it("returns real data URLs, in page order", async () => {
    const first = await photo(1);
    const second = await photo(5);
    const storage = storageStub({
      download: vi.fn(async (_b: string, p: string) =>
        p.endsWith("page-1.jpg") ? first : second,
      ),
    });

    const urls = await loadImportPageDataUrls(IMPORT, RESTAURANT, {
      records: loadedRecords(),
      storage,
    });

    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(urls[0]).toBe(`data:image/jpeg;base64,${first.toString("base64")}`);
    expect(urls[1]).toBe(`data:image/jpeg;base64,${second.toString("base64")}`);
    // Order is the user's page order, which matters: a menu's categories
    // continue across a page break.
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("reads only the paths the server recorded, never a caller's", async () => {
    const storage = storageStub();
    await loadImportPageDataUrls(IMPORT, RESTAURANT, {
      records: loadedRecords(),
      storage,
    });

    const downloaded = (storage.download as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(downloaded.map((c) => c[1])).toEqual([
      `${RESTAURANT}/${IMPORT}/page-1.jpg`,
      `${RESTAURANT}/${IMPORT}/page-2.jpg`,
    ]);
    for (const [bucket] of downloaded) {
      expect(bucket).toBe(MENU_IMPORTS_BUCKET);
    }
  });

  it("refuses an import belonging to another restaurant", async () => {
    const storage = storageStub();
    const records = loadedRecords({
      load: vi.fn(async () => ({
        restaurantId: OTHER_RESTAURANT,
        status: "uploaded",
        sourcePaths: [`${OTHER_RESTAURANT}/${IMPORT}/page-1.jpg`],
      })),
    });

    await expect(
      loadImportPageDataUrls(IMPORT, RESTAURANT, { records, storage }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(storage.download).not.toHaveBeenCalled();
  });

  it("refuses an import that does not exist or is invisible under RLS", async () => {
    await expect(
      loadImportPageDataUrls(IMPORT, RESTAURANT, {
        records: recordsStub(),
        storage: storageStub(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a recorded path that escapes the import's folder", async () => {
    const storage = storageStub();
    const records = loadedRecords({
      load: vi.fn(async () => ({
        restaurantId: RESTAURANT,
        status: "uploaded",
        sourcePaths: [`${OTHER_RESTAURANT}/${IMPORT}/page-1.jpg`],
      })),
    });

    await expect(
      loadImportPageDataUrls(IMPORT, RESTAURANT, { records, storage }),
    ).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(storage.download).not.toHaveBeenCalled();
  });

  it("stops the whole import when one page never arrived", async () => {
    // A missing page would otherwise extract as a partial price list.
    const storage = storageStub({
      download: vi.fn(async (_b: string, p: string) => {
        if (p.endsWith("page-2.jpg")) throw new Error("404");
        return photo(1);
      }),
    });

    await expect(
      loadImportPageDataUrls(IMPORT, RESTAURANT, {
        records: loadedRecords(),
        storage,
      }),
    ).rejects.toMatchObject({ code: "MISSING_OBJECT" });
  });

  it("names the page that is missing", async () => {
    const storage = storageStub({
      download: vi.fn(async () => {
        throw new Error("404");
      }),
    });

    await expect(
      loadImportPageDataUrls(IMPORT, RESTAURANT, {
        records: loadedRecords(),
        storage,
      }),
    ).rejects.toThrow(/Page 1 was not uploaded/);
  });

  it("refuses an import with no recorded pages", async () => {
    const records = loadedRecords({
      load: vi.fn(async () => ({
        restaurantId: RESTAURANT,
        status: "uploaded",
        sourcePaths: [],
      })),
    });

    await expect(
      loadImportPageDataUrls(IMPORT, RESTAURANT, {
        records,
        storage: storageStub(),
      }),
    ).rejects.toMatchObject({ code: "NO_PAGES" });
  });
});

/**
 * Reads a source file with comments removed. These assertions are about
 * what the code does; the comments deliberately describe the old base64
 * transport and the dish-photo lifecycle this must not touch, and matching
 * that prose would fail for the wrong reason.
 */
function codeOnly(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("the 1 MB server-action defect is actually gone", () => {
  it("no longer builds data URLs in the browser", () => {
    const component = codeOnly(
      "src/components/dashboard/menu-import-upload.tsx",
    );
    expect(component).not.toContain("readAsDataURL");
    expect(component).not.toContain("FileReader");
    // Bytes go to Storage with the signed token instead.
    expect(component).toContain("uploadToSignedUrl");
  });

  it("sends only content types to the server, never bytes", () => {
    const component = codeOnly(
      "src/components/dashboard/menu-import-upload.tsx",
    );
    expect(component).toContain("pages.map((file) => file.type)");
    // The old transport posted each page as a hidden form field.
    expect(component).not.toContain('name="page"');
  });

  it("keeps import pages out of the dish-photo lifecycle entirely", () => {
    const core = codeOnly("src/lib/menu-import/upload-core.ts");
    expect(core).not.toContain("menu_item_images");
    // No dish-photo bucket is reachable from the import path.
    expect(core).not.toContain('"menu-photos"');
    expect(core).not.toContain("menu-photos-private");
    // Only the genuinely generic helpers are shared with phase 2.
    expect(core).toContain("isValidObjectPath");
  });

  it("reports a rejection type callers can act on", () => {
    const error = new ImportUploadRejected("NO_PAGES", "none");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NO_PAGES");
  });
});
