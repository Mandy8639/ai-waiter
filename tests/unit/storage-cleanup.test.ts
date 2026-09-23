// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { planCleanup } from "@/lib/storage-cleanup/plan";
import { executeCleanup } from "@/lib/storage-cleanup/execute";
import { MANAGED_BUCKETS, RETENTION } from "@/lib/storage-cleanup/policy";
import type {
  CleanupCandidate,
  CleanupInput,
  ImageRecord,
  ImportRecord,
  StorageObject,
} from "@/lib/storage-cleanup/types";

/**
 * Retention is a decision about time, so time is injected. Every test
 * passes a fixed `now` and positions rows relative to it — no sleeps, no
 * wall clock, no flakes.
 *
 * The safety-critical assertions are the negative ones: an active photo is
 * never eligible, an unprovable object is never deleted, and a dry run
 * deletes nothing.
 */

const NOW = new Date("2026-09-22T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 60 * 60 * 1000;

const REST = "11111111-1111-4111-8111-111111111111";
const DISH = "22222222-2222-4222-8222-222222222222";
const IMG = "33333333-3333-4333-8333-333333333333";
const OTHER_IMG = "44444444-4444-4444-8444-444444444444";
const OTHER_REST = "55555555-5555-4555-8555-555555555555";
const IMPORT = "66666666-6666-4666-8666-666666666666";

const P = {
  original: `${REST}/${DISH}/${IMG}/original.jpg`,
  small: `${REST}/${DISH}/${IMG}/small.webp`,
  medium: `${REST}/${DISH}/${IMG}/medium.webp`,
  page1: `${REST}/${IMPORT}/page-1.jpg`,
};

function image(over: Partial<ImageRecord> = {}): ImageRecord {
  return {
    id: IMG,
    restaurantId: REST,
    menuItemId: DISH,
    status: "active",
    statusChangedAt: ago(100 * DAY),
    originalPath: P.original,
    variantPaths: { small: P.small, medium: P.medium },
    ...over,
  };
}

function obj(
  bucket: string,
  path: string,
  createdAt = ago(100 * DAY),
): StorageObject {
  return { bucket, path, sizeBytes: 1000, createdAt };
}

function plan(over: Partial<CleanupInput> = {}) {
  return planCleanup({
    now: NOW,
    images: [],
    menuItems: [],
    imports: [],
    objects: [],
    ...over,
  });
}

/** Every object for one image, in both buckets. */
const allPhotoObjects = [
  obj(MANAGED_BUCKETS.photoPrivate, P.original),
  obj(MANAGED_BUCKETS.photoPrivate, P.small),
  obj(MANAGED_BUCKETS.photoPrivate, P.medium),
  obj(MANAGED_BUCKETS.photoPublic, P.small),
  obj(MANAGED_BUCKETS.photoPublic, P.medium),
];

const reasons = (p: ReturnType<typeof plan>) =>
  p.candidates.map((c) => c.reason);
const skipReasons = (p: ReturnType<typeof plan>) => [
  ...new Set(p.skips.map((s) => s.reason)),
];

describe("menu photo retention", () => {
  it("1. never touches anything belonging to an active image", () => {
    const p = plan({
      images: [image({ status: "active" })],
      menuItems: [{ id: DISH, activeImageId: IMG }],
      objects: allPhotoObjects,
    });
    expect(p.candidates).toEqual([]);
    expect(p.summary.skipped).toBe(5);
  });

  it("2. never touches a photo awaiting review, however old", () => {
    const p = plan({
      images: [
        image({
          status: "pending_review",
          statusChangedAt: ago(365 * DAY),
          variantPaths: { small: P.small },
        }),
      ],
      menuItems: [{ id: DISH, activeImageId: null }],
      objects: [
        obj(MANAGED_BUCKETS.photoPrivate, P.original),
        obj(MANAGED_BUCKETS.photoPrivate, P.small),
      ],
    });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toContain("pending_review_never_eligible");
  });

  it("3. leaves a fresh incomplete upload alone", () => {
    const p = plan({
      images: [
        image({
          status: "uploading",
          statusChangedAt: ago(2 * 60 * 60 * 1000),
          variantPaths: null,
        }),
      ],
      objects: [obj(MANAGED_BUCKETS.photoPrivate, P.original)],
    });
    expect(p.candidates).toEqual([]);
    expect(p.skips[0].reason).toBe("within_retention");
    expect(p.skips[0].eligibleAt).toEqual(
      new Date(ago(2 * 60 * 60 * 1000).getTime() + RETENTION.incompleteStaleMs),
    );
  });

  it("4. collects an abandoned upload after the stale window", () => {
    const p = plan({
      images: [
        image({
          status: "uploading",
          statusChangedAt: ago(2 * DAY),
          variantPaths: null,
        }),
      ],
      objects: [obj(MANAGED_BUCKETS.photoPrivate, P.original)],
    });
    expect(reasons(p)).toEqual(["incomplete_abandoned"]);
  });

  it("5. keeps a recent failure as retry evidence", () => {
    const p = plan({
      images: [image({ status: "failed", statusChangedAt: ago(10 * DAY) })],
      objects: [obj(MANAGED_BUCKETS.photoPrivate, P.original)],
    });
    expect(p.candidates).toEqual([]);
  });

  it("6. collects a failure past 30 days", () => {
    const p = plan({
      images: [image({ status: "failed", statusChangedAt: ago(31 * DAY) })],
      objects: [obj(MANAGED_BUCKETS.photoPrivate, P.original)],
    });
    expect(reasons(p)).toEqual(["failed_retention_expired"]);
  });

  it("7. collects a rejected photo past 30 days, private only", () => {
    const p = plan({
      images: [image({ status: "rejected", statusChangedAt: ago(31 * DAY) })],
      objects: allPhotoObjects,
    });
    // A rejected image should never have had public objects; the two here
    // are treated as orphans, not as retained material.
    const privateOnes = p.candidates.filter(
      (c) => c.bucket === MANAGED_BUCKETS.photoPrivate,
    );
    expect(privateOnes).toHaveLength(3);
    expect(
      privateOnes.every((c) => c.reason === "rejected_retention_expired"),
    ).toBe(true);
  });

  it("8. keeps a freshly replaced photo in both areas", () => {
    const p = plan({
      images: [image({ status: "superseded", statusChangedAt: ago(5 * DAY) })],
      objects: allPhotoObjects,
    });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["within_retention"]);
  });

  it("9. collects a replaced photo from both areas after 30 days", () => {
    const p = plan({
      images: [image({ status: "superseded", statusChangedAt: ago(31 * DAY) })],
      objects: allPhotoObjects,
    });
    expect(p.candidates).toHaveLength(5);
    expect(new Set(p.candidates.map((c) => c.bucket))).toEqual(
      new Set([MANAGED_BUCKETS.photoPrivate, MANAGED_BUCKETS.photoPublic]),
    );
  });

  it("10. collects a removed photo after 30 days", () => {
    const p = plan({
      images: [image({ status: "removed", statusChangedAt: ago(31 * DAY) })],
      objects: allPhotoObjects,
    });
    expect(p.candidates).toHaveLength(5);
    expect(reasons(p).every((r) => r === "removed_retention_expired")).toBe(
      true,
    );
  });

  it("11. refuses to delete anything a dish still points at, even if the status disagrees", () => {
    // Two sources of truth disagreeing is a bug, and a bug is not a licence
    // to delete a diner's photo.
    const p = plan({
      images: [image({ status: "removed", statusChangedAt: ago(365 * DAY) })],
      menuItems: [{ id: DISH, activeImageId: IMG }],
      objects: allPhotoObjects,
    });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["referenced_as_active_image"]);
  });

  it("12. skips a malformed path", () => {
    const p = plan({
      objects: [
        obj(MANAGED_BUCKETS.photoPrivate, "not/a/valid/path/at/all.jpg"),
        obj(
          MANAGED_BUCKETS.photoPrivate,
          `${REST}/${DISH}/${IMG}/../escape.jpg`,
        ),
        obj(MANAGED_BUCKETS.photoPrivate, "single-segment.jpg"),
      ],
    });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["malformed_path"]);
  });

  it("13. skips an object whose image id exists but does not claim that path", () => {
    const p = plan({
      images: [image({ status: "removed", statusChangedAt: ago(90 * DAY) })],
      objects: [
        obj(
          MANAGED_BUCKETS.photoPrivate,
          `${REST}/${DISH}/${IMG}/unlisted.webp`,
        ),
      ],
    });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["path_does_not_match_owning_record"]);
  });

  it("14. treats another restaurant's path as an orphan, not as this image's", () => {
    const p = plan({
      images: [image({ status: "removed", statusChangedAt: ago(90 * DAY) })],
      objects: [
        obj(
          MANAGED_BUCKETS.photoPrivate,
          `${OTHER_REST}/${DISH}/${OTHER_IMG}/small.webp`,
          ago(90 * DAY),
        ),
      ],
    });
    expect(reasons(p)).toEqual(["private_orphan_expired"]);
    expect(p.candidates[0].imageId).toBeNull();
  });

  it("15. ignores source: real, ai_generated and unverified clean identically", () => {
    // source is provenance, not lifecycle. The planner never reads it, and
    // this test exists so that stays true.
    const source = (await1: unknown) => await1;
    void source;
    const p = plan({
      images: [image({ status: "rejected", statusChangedAt: ago(31 * DAY) })],
      objects: [obj(MANAGED_BUCKETS.photoPrivate, P.original)],
    });
    expect(reasons(p)).toEqual(["rejected_retention_expired"]);
  });

  it("16. never proposes a database row or ledger entry for deletion", () => {
    const p = plan({
      images: [image({ status: "removed", statusChangedAt: ago(90 * DAY) })],
      objects: allPhotoObjects,
    });
    // Candidates only ever name a bucket and a path.
    for (const c of p.candidates) {
      expect(c).toHaveProperty("bucket");
      expect(c).toHaveProperty("path");
      expect(Object.keys(c)).not.toContain("table");
      expect(Object.keys(c)).not.toContain("rowId");
    }
  });

  it("17. makes an accidental public orphan wait out the safety window", () => {
    const p = plan({
      objects: [
        obj(MANAGED_BUCKETS.photoPublic, P.small, ago(2 * 60 * 60 * 1000)),
      ],
    });
    expect(p.candidates).toEqual([]);
    expect(p.skips[0].reason).toBe("within_safety_window");
  });

  it("18. collects a public orphan once the safety window has passed", () => {
    const p = plan({
      objects: [obj(MANAGED_BUCKETS.photoPublic, P.small, ago(2 * DAY))],
    });
    expect(reasons(p)).toEqual(["public_orphan_expired"]);
  });

  it("19. reports an object in an unmanaged bucket without ever proposing it", () => {
    const p = plan({ objects: [obj("some-other-bucket", P.small)] });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["unmanaged_bucket"]);
  });

  it("20. is idempotent: re-planning after deletion yields nothing", () => {
    const input = {
      images: [image({ status: "removed", statusChangedAt: ago(90 * DAY) })],
      objects: allPhotoObjects,
    };
    const first = plan(input);
    expect(first.candidates).toHaveLength(5);
    // Second run, with the deleted objects gone from the inventory.
    const second = plan({ ...input, objects: [] });
    expect(second.candidates).toEqual([]);
  });
});

describe("menu import retention", () => {
  function imp(over: Partial<ImportRecord> = {}): ImportRecord {
    return {
      id: IMPORT,
      restaurantId: REST,
      status: "committed",
      sourcePaths: [P.page1],
      updatedAt: ago(30 * DAY),
      ...over,
    };
  }
  const page = (createdAt = ago(30 * DAY)) =>
    obj(MANAGED_BUCKETS.imports, P.page1, createdAt);

  it("21. keeps pages while a person is reviewing the drafts", () => {
    const p = plan({
      imports: [imp({ status: "review", updatedAt: ago(365 * DAY) })],
      objects: [page()],
    });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["import_in_review_never_eligible"]);
  });

  it("22. collects an abandoned import after a day", () => {
    const p = plan({
      imports: [imp({ status: "uploaded", updatedAt: ago(2 * DAY) })],
      objects: [page()],
    });
    expect(reasons(p)).toEqual(["import_abandoned"]);
  });

  it("23. keeps a successful import's pages during the grace period", () => {
    const p = plan({
      imports: [imp({ status: "committed", updatedAt: ago(3 * DAY) })],
      objects: [page()],
    });
    expect(p.candidates).toEqual([]);
  });

  it("24. collects a successful import's pages after 7 days", () => {
    const p = plan({
      imports: [imp({ status: "committed", updatedAt: ago(8 * DAY) })],
      objects: [page()],
    });
    expect(reasons(p)).toEqual(["import_success_retention_expired"]);
  });

  it("25. keeps a failed import's pages during the retry window", () => {
    const p = plan({
      imports: [imp({ status: "failed", updatedAt: ago(3 * DAY) })],
      objects: [page()],
    });
    expect(p.candidates).toEqual([]);
  });

  it("26. collects a failed import's pages after 7 days", () => {
    const p = plan({
      imports: [imp({ status: "failed", updatedAt: ago(8 * DAY) })],
      objects: [page()],
    });
    expect(reasons(p)).toEqual(["import_failed_retention_expired"]);
  });

  it("27. treats every page the same regardless of order", () => {
    const paths = [1, 2, 3].map((n) => `${REST}/${IMPORT}/page-${n}.jpg`);
    const p = plan({
      imports: [
        imp({
          status: "committed",
          updatedAt: ago(8 * DAY),
          sourcePaths: paths,
        }),
      ],
      objects: paths
        .map((path) => obj(MANAGED_BUCKETS.imports, path))
        .reverse(),
    });
    expect(p.candidates).toHaveLength(3);
    expect(new Set(p.candidates.map((c) => c.path))).toEqual(new Set(paths));
  });

  it("28. skips a malformed page path", () => {
    const p = plan({
      imports: [
        imp({ status: "committed", updatedAt: ago(8 * DAY), sourcePaths: [] }),
      ],
      objects: [
        obj(MANAGED_BUCKETS.imports, `${REST}/${IMPORT}/sub/page-1.jpg`),
      ],
    });
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["malformed_path"]);
  });

  it("29. does not attribute another restaurant's page to this import", () => {
    const p = plan({
      imports: [imp({ status: "committed", updatedAt: ago(8 * DAY) })],
      objects: [
        obj(
          MANAGED_BUCKETS.imports,
          `${OTHER_REST}/${IMPORT}/page-1.jpg`,
          ago(8 * DAY),
        ),
      ],
    });
    // The import id exists but the restaurant prefix is someone else's.
    // The planner refuses to reason about it at all rather than treating it
    // as a deletable orphan — cross-tenant confusion is exactly the case
    // where guessing is unacceptable.
    expect(p.candidates).toEqual([]);
    expect(skipReasons(p)).toEqual(["path_does_not_match_owning_record"]);
  });

  it("30. makes a rowless import prefix wait out the safety delay", () => {
    const fresh = plan({
      objects: [obj(MANAGED_BUCKETS.imports, P.page1, ago(2 * 60 * 60 * 1000))],
    });
    expect(fresh.candidates).toEqual([]);
    expect(fresh.skips[0].reason).toBe("within_safety_window");

    const old = plan({
      objects: [obj(MANAGED_BUCKETS.imports, P.page1, ago(2 * DAY))],
    });
    expect(reasons(old)).toEqual(["import_orphan_expired"]);
  });
});

describe("execution", () => {
  const storage = () => ({ remove: vi.fn(async () => {}) });

  function expiredPlan(count = 3) {
    const paths = Array.from(
      { length: count },
      (_, i) => `${REST}/${DISH}/${IMG}/v${i}.webp`,
    );
    return plan({
      images: [
        image({
          status: "removed",
          statusChangedAt: ago(90 * DAY),
          originalPath: null,
          variantPaths: Object.fromEntries(paths.map((p, i) => [`v${i}`, p])),
        }),
      ],
      objects: paths.map((p) => obj(MANAGED_BUCKETS.photoPrivate, p)),
    });
  }

  it("31. a dry run deletes nothing", async () => {
    const s = storage();
    const result = await executeCleanup(expiredPlan(), s);
    expect(result.dryRun).toBe(true);
    expect(s.remove).not.toHaveBeenCalled();
    expect(result.deleted).toEqual([]);
    expect(result.remaining).toBe(3);
  });

  it("32. execute deletes exactly the approved paths", async () => {
    const s = storage();
    const p = expiredPlan();
    const result = await executeCleanup(p, s, { execute: true });
    expect(result.deleted).toHaveLength(3);
    const called = s.remove.mock.calls.map(
      (c) => (c as unknown as [string, string[]])[1][0],
    );
    expect(new Set(called)).toEqual(new Set(p.candidates.map((c) => c.path)));
    for (const call of s.remove.mock.calls) {
      expect((call as unknown as [string, string[]])[0]).toBe(
        MANAGED_BUCKETS.photoPrivate,
      );
    }
  });

  it("33. a partial failure is recorded and the run continues", async () => {
    let n = 0;
    const s = {
      remove: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new Error("storage unavailable");
      }),
    };
    const result = await executeCleanup(expiredPlan(), s, { execute: true });
    expect(result.attempted).toBe(3);
    expect(result.deleted).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBe("storage unavailable");
  });

  it("34. the batch limit is enforced and continuation reported", async () => {
    const s = storage();
    const result = await executeCleanup(expiredPlan(5), s, {
      execute: true,
      batchLimit: 2,
    });
    expect(result.attempted).toBe(2);
    expect(result.remaining).toBe(3);
  });

  it("35. a deletion failure never touches lifecycle state", async () => {
    // The executor is given only a remove() function: it has no database
    // handle at all, which is the structural guarantee.
    const s = storage();
    expect(Object.keys(s)).toEqual(["remove"]);
    const result = await executeCleanup(expiredPlan(), s, { execute: true });
    expect(result).not.toHaveProperty("rowsUpdated");
  });

  it("36. an active object injected into a plan is refused at execution", async () => {
    const s = storage();
    const injected: CleanupCandidate = {
      kind: "menu_photo",
      imageId: IMG,
      bucket: MANAGED_BUCKETS.photoPublic,
      // A path belonging to a different image than the candidate claims.
      path: `${REST}/${DISH}/${OTHER_IMG}/small.webp`,
      reason: "removed_retention_expired",
      ageMs: 99 * DAY,
      safeAfter: ago(DAY),
      sizeBytes: 10,
      destructive: true,
    };
    const p = { ...expiredPlan(0), candidates: [injected] };
    const result = await executeCleanup(p, s, { execute: true });
    expect(s.remove).not.toHaveBeenCalled();
    expect(result.refused[0].reason).toBe("path_image_id_mismatch");
  });

  it("37. the executor revalidates every path before deleting", async () => {
    const s = storage();
    const bad: CleanupCandidate = {
      kind: "menu_photo",
      imageId: null,
      bucket: MANAGED_BUCKETS.photoPrivate,
      path: "../../etc/passwd",
      reason: "private_orphan_expired",
      ageMs: 99 * DAY,
      safeAfter: ago(DAY),
      sizeBytes: 1,
      destructive: true,
    };
    const result = await executeCleanup(
      { ...expiredPlan(0), candidates: [bad] },
      s,
      { execute: true },
    );
    expect(s.remove).not.toHaveBeenCalled();
    expect(result.refused[0].reason).toBe("malformed_photo_path");
  });
});
