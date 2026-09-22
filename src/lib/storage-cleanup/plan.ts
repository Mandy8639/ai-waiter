import {
  IMAGE_POLICY,
  IMPORT_POLICY,
  MANAGED_BUCKETS,
  RETENTION,
  isManagedBucket,
  type ManagedBucket,
} from "./policy";
import type {
  CleanupCandidate,
  CleanupInput,
  CleanupPlan,
  CleanupSkip,
} from "./types";
import { isValidObjectPath } from "@/lib/menu-images/paths";
import { isValidImportPagePath } from "@/lib/menu-import/upload-core";

/**
 * Stage 1: work out what may be deleted, and say why for every object.
 *
 * Pure. Given the same database rows, object inventory and `now`, it
 * returns the same plan — which is what lets retention be tested without a
 * clock and reviewed without a storage service.
 *
 * The planner never deletes and never calls Storage. It answers one
 * question per object: does a database row prove this object's lifecycle
 * has retired, and has its retention window passed? Anything it cannot
 * prove is skipped with a reason, and the reasons are reported as loudly as
 * the candidates. A cleanup system that silently skips is indistinguishable
 * from one that silently deletes the wrong thing.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function planCleanup(input: CleanupInput): CleanupPlan {
  const { now, images, menuItems, imports, objects } = input;
  const candidates: CleanupCandidate[] = [];
  const skips: CleanupSkip[] = [];

  const imageById = new Map(images.map((i) => [i.id, i]));
  const importById = new Map(imports.map((i) => [i.id, i]));

  /**
   * Every image id a dish currently points at. This is the hard veto: even
   * if a row's status somehow said `removed`, an object belonging to an
   * image a dish still points at is never deleted. Two sources of truth
   * disagreeing is a bug, and a bug is not a licence to delete a diner's
   * photo.
   */
  const activeImageIds = new Set(
    menuItems
      .map((m) => m.activeImageId)
      .filter((id): id is string => Boolean(id)),
  );

  /** Which image legitimately owns a given object path, per the database. */
  const ownerByPath = new Map<string, { imageId: string; isPublic: boolean }>();
  for (const image of images) {
    if (image.originalPath) {
      ownerByPath.set(`${MANAGED_BUCKETS.photoPrivate}:${image.originalPath}`, {
        imageId: image.id,
        isPublic: false,
      });
    }
    for (const path of Object.values(image.variantPaths ?? {})) {
      ownerByPath.set(`${MANAGED_BUCKETS.photoPrivate}:${path}`, {
        imageId: image.id,
        isPublic: false,
      });
      ownerByPath.set(`${MANAGED_BUCKETS.photoPublic}:${path}`, {
        imageId: image.id,
        isPublic: true,
      });
    }
  }

  const importPathOwner = new Map<string, string>();
  for (const imp of imports) {
    for (const path of imp.sourcePaths) {
      importPathOwner.set(`${MANAGED_BUCKETS.imports}:${path}`, imp.id);
    }
  }

  for (const object of objects) {
    if (!isManagedBucket(object.bucket)) {
      skips.push({
        bucket: object.bucket,
        path: object.path,
        reason: "unmanaged_bucket",
      });
      continue;
    }

    // Captured after the guard: TypeScript's narrowing does not survive
    // into the nested closures below.
    const bucket: ManagedBucket = object.bucket;

    if (bucket === MANAGED_BUCKETS.imports) {
      planImportObject();
      continue;
    }
    planPhotoObject();

    function planPhotoObject() {
      const key = `${object.bucket}:${object.path}`;
      const owner = ownerByPath.get(key);
      const isPublicBucket = object.bucket === MANAGED_BUCKETS.photoPublic;

      // No owning row at all. Could be a failed publish's compensation that
      // has not run, a deleted row's leftovers, or something nobody
      // recognises. Only the recognisable, aged cases are ever deleted.
      if (!owner) {
        const parsed = parsePhotoPath(object.path);
        if (!parsed) {
          skips.push({
            bucket: object.bucket,
            path: object.path,
            reason: "malformed_path",
          });
          return;
        }
        // The path parses, but does any row claim that image id? If a row
        // exists and simply does not list this path, the object is not ours
        // to reason about — report it rather than guess.
        if (imageById.has(parsed.imageId)) {
          skips.push({
            bucket: object.bucket,
            path: object.path,
            reason: "path_does_not_match_owning_record",
            imageId: parsed.imageId,
          });
          return;
        }
        if (activeImageIds.has(parsed.imageId)) {
          skips.push({
            bucket: object.bucket,
            path: object.path,
            reason: "referenced_as_active_image",
            imageId: parsed.imageId,
          });
          return;
        }

        const safetyMs = RETENTION.publicOrphanSafetyMs;
        const safeAfter = new Date(object.createdAt.getTime() + safetyMs);
        if (safeAfter > now) {
          skips.push({
            bucket: object.bucket,
            path: object.path,
            reason: "within_safety_window",
            eligibleAt: safeAfter,
          });
          return;
        }
        candidates.push({
          kind: "menu_photo",
          imageId: null,
          bucket,
          path: object.path,
          reason: isPublicBucket
            ? "public_orphan_expired"
            : "private_orphan_expired",
          ageMs: now.getTime() - object.createdAt.getTime(),
          safeAfter,
          sizeBytes: object.sizeBytes,
          destructive: true,
        });
        return;
      }

      const image = imageById.get(owner.imageId);
      if (!image) {
        // Should not happen: ownerByPath is built from images.
        skips.push({
          bucket: object.bucket,
          path: object.path,
          reason: "path_does_not_match_owning_record",
          imageId: owner.imageId,
        });
        return;
      }

      // The veto, before any status or age reasoning.
      if (activeImageIds.has(image.id)) {
        skips.push({
          bucket: object.bucket,
          path: object.path,
          reason: "referenced_as_active_image",
          imageId: image.id,
        });
        return;
      }

      const policy = IMAGE_POLICY[image.status];
      const retentionMs = isPublicBucket
        ? policy.publicRetentionMs
        : policy.privateRetentionMs;

      if (retentionMs === null) {
        skips.push({
          bucket: object.bucket,
          path: object.path,
          reason:
            image.status === "active"
              ? "active_never_eligible"
              : image.status === "pending_review"
                ? "pending_review_never_eligible"
                : "within_retention",
          imageId: image.id,
        });
        return;
      }

      const safeAfter = new Date(image.statusChangedAt.getTime() + retentionMs);
      if (safeAfter > now) {
        skips.push({
          bucket: object.bucket,
          path: object.path,
          reason: "within_retention",
          imageId: image.id,
          eligibleAt: safeAfter,
        });
        return;
      }

      candidates.push({
        kind: "menu_photo",
        imageId: image.id,
        bucket,
        path: object.path,
        reason: policy.reason as CleanupCandidate["reason"],
        ageMs: now.getTime() - image.statusChangedAt.getTime(),
        safeAfter,
        sizeBytes: object.sizeBytes,
        destructive: true,
      });
    }

    function planImportObject() {
      const key = `${MANAGED_BUCKETS.imports}:${object.path}`;
      const importId = importPathOwner.get(key);

      if (!importId) {
        const parsed = parseImportPath(object.path);
        if (!parsed) {
          skips.push({
            bucket: object.bucket,
            path: object.path,
            reason: "malformed_path",
          });
          return;
        }
        if (importById.has(parsed.importId)) {
          // The row exists but does not list this page.
          skips.push({
            bucket: object.bucket,
            path: object.path,
            reason: "path_does_not_match_owning_record",
            importId: parsed.importId,
          });
          return;
        }
        const safeAfter = new Date(
          object.createdAt.getTime() + RETENTION.importAbandonedMs,
        );
        if (safeAfter > now) {
          skips.push({
            bucket: object.bucket,
            path: object.path,
            reason: "within_safety_window",
            eligibleAt: safeAfter,
          });
          return;
        }
        candidates.push({
          kind: "menu_import",
          importId: null,
          bucket: MANAGED_BUCKETS.imports,
          path: object.path,
          reason: "import_orphan_expired",
          ageMs: now.getTime() - object.createdAt.getTime(),
          safeAfter,
          sizeBytes: object.sizeBytes,
          destructive: true,
        });
        return;
      }

      const imp = importById.get(importId)!;
      const policy = IMPORT_POLICY[imp.status];
      if (policy.retentionMs === null) {
        skips.push({
          bucket: object.bucket,
          path: object.path,
          reason: "import_in_review_never_eligible",
          importId: imp.id,
        });
        return;
      }
      const safeAfter = new Date(imp.updatedAt.getTime() + policy.retentionMs);
      if (safeAfter > now) {
        skips.push({
          bucket: object.bucket,
          path: object.path,
          reason: "within_retention",
          importId: imp.id,
          eligibleAt: safeAfter,
        });
        return;
      }
      candidates.push({
        kind: "menu_import",
        importId: imp.id,
        bucket: MANAGED_BUCKETS.imports,
        path: object.path,
        reason: policy.reason as CleanupCandidate["reason"],
        ageMs: now.getTime() - imp.updatedAt.getTime(),
        safeAfter,
        sizeBytes: object.sizeBytes,
        destructive: true,
      });
    }
  }

  const byReason: Record<string, number> = {};
  for (const c of candidates)
    byReason[c.reason] = (byReason[c.reason] ?? 0) + 1;
  for (const s of skips)
    byReason[`skip:${s.reason}`] = (byReason[`skip:${s.reason}`] ?? 0) + 1;

  return {
    now,
    candidates,
    skips,
    summary: {
      objectsConsidered: objects.length,
      eligible: candidates.length,
      skipped: skips.length,
      reclaimableBytes: candidates.reduce((a, c) => a + (c.sizeBytes ?? 0), 0),
      byReason,
    },
  };
}

/**
 * `{restaurant}/{dish}/{image}/{file}` with every segment a real UUID and
 * the file name inside the image's own folder, checked with the same
 * allow-list the database uses. Anything else is not a path this system
 * produced, so it is not a path this system deletes.
 */
export function parsePhotoPath(path: string): {
  restaurantId: string;
  menuItemId: string;
  imageId: string;
} | null {
  const parts = path.split("/");
  if (parts.length !== 4) return null;
  const [restaurantId, menuItemId, imageId] = parts;
  if (![restaurantId, menuItemId, imageId].every((p) => UUID.test(p)))
    return null;
  if (!isValidObjectPath(path, `${restaurantId}/${menuItemId}/${imageId}/`)) {
    return null;
  }
  return { restaurantId, menuItemId, imageId };
}

/** `{restaurant}/{import}/page-N.ext`, validated the same way. */
export function parseImportPath(
  path: string,
): { restaurantId: string; importId: string } | null {
  const parts = path.split("/");
  if (parts.length !== 3) return null;
  const [restaurantId, importId] = parts;
  if (![restaurantId, importId].every((p) => UUID.test(p))) return null;
  if (!isValidImportPagePath(path, restaurantId, importId)) return null;
  return { restaurantId, importId };
}
