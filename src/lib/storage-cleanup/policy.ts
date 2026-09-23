/**
 * What may be deleted from Storage, and when.
 *
 * THE RULE THAT SHAPES EVERYTHING ELSE: cleanup is database-led. A storage
 * listing never decides anything on its own. An object is deleted because a
 * database row says its lifecycle has retired and the retention window has
 * passed — never because the object is old. "Old" is a property of bytes;
 * "safe to delete" is a property of the lifecycle that owns them.
 *
 * The second rule: Storage retention and database retention are separate
 * decisions. This phase deletes bytes only. Provenance, timestamps, source
 * and lifecycle history stay in Postgres, because they are small and they
 * are the record of what a restaurant published to diners. The generation
 * attempt ledger is append-only and is never touched at all.
 */

/** menu_item_images.status — every value the schema allows, no inventions. */
export const IMAGE_STATUSES = [
  "uploading",
  "generating",
  "pending_review",
  "active",
  "superseded",
  "rejected",
  "removed",
  "failed",
] as const;
export type ImageStatus = (typeof IMAGE_STATUSES)[number];

/** restaurant_hero_videos.status — every value the schema allows. */
export const HERO_VIDEO_STATUSES = [
  "uploading",
  "pending_review",
  "active",
  "superseded",
  "rejected",
  "removed",
  "failed",
] as const;
export type HeroVideoStatus = (typeof HERO_VIDEO_STATUSES)[number];

/** menu_imports.status — likewise. */
export const IMPORT_STATUSES = [
  "uploaded",
  "extracting",
  "review",
  "committed",
  "failed",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

const HOURS = 60 * 60 * 1000;
const DAYS = 24 * HOURS;

/**
 * Every retention period, in one place, each with the reason it exists.
 * Nothing in plan.ts or execute.ts may hard-code a duration.
 */
export const RETENTION = {
  /**
   * An upload or generation that never reached a terminal state. Long
   * enough that a slow phone upload, a closed laptop or a retried request
   * is never mistaken for abandonment.
   *
   * Not to be confused with menu_image_generation_limits.generation_timeout_seconds
   * (180s), which frees a *quota* slot. That is about letting an owner try
   * again; this is about deleting bytes, so it is far more conservative.
   */
  incompleteStaleMs: 24 * HOURS,

  /** A processing failure. The original is the evidence for a retry, so it outlives the failure by a month. */
  failedMs: 30 * DAYS,

  /** An owner said no. Kept a month in case they change their mind; no public object ever existed. */
  rejectedMs: 30 * DAYS,

  /**
   * Replaced by a newer photo. The public objects may still be in a CDN, a
   * browser cache or an open tab, and docs/MENU_PHOTO_STRATEGY.md promises
   * a 30-day undo window.
   */
  supersededMs: 30 * DAYS,

  /** Taken down by an owner. Same 30 days, same undo promise. */
  removedMs: 30 * DAYS,

  /**
   * A public object with no legitimate owning row. Almost always the brief
   * window during a failed publish, which Phase 2 compensates for within
   * seconds. Waiting a day means a compensating delete that is merely slow
   * is never raced by cleanup.
   */
  publicOrphanSafetyMs: 24 * HOURS,

  /** An import authorized but never extracted. Same reasoning as an abandoned upload. */
  importAbandonedMs: 24 * HOURS,

  /**
   * Import pages after a successful commit. They are working material —
   * the menu they produced is already in menu_items — but a week lets a
   * restaurant notice a misread price and look at the photograph again.
   */
  importSuccessMs: 7 * DAYS,

  /** A failed import. Same week, for retry and diagnosis. */
  importFailedMs: 7 * DAYS,
} as const;

/**
 * A hero video's retention, kept identical to a photo's on purpose.
 *
 * The temptation is to delete videos sooner because they are the biggest
 * objects in the system — a 50 MB hero against a 200 KB dish photo. That
 * would be optimising storage cost against the one promise the owner UI
 * makes them ("the old one is kept for 30 days"), and a promise made in
 * the product is not something the cleanup engine gets to renegotiate.
 */
export const HERO_VIDEO_RETENTION = {
  incompleteStaleMs: RETENTION.incompleteStaleMs,
  failedMs: RETENTION.failedMs,
  rejectedMs: RETENTION.rejectedMs,
  supersededMs: RETENTION.supersededMs,
  removedMs: RETENTION.removedMs,
  orphanSafetyMs: RETENTION.publicOrphanSafetyMs,
} as const;

/** How many objects one run may delete. Bounded so a bug cannot run away. */
export const DEFAULT_BATCH_LIMIT = 100;

/** The only buckets this system will ever touch. */
export const MANAGED_BUCKETS = {
  photoPrivate: "menu-photos-private",
  photoPublic: "menu-photos",
  imports: "menu-imports",
  videoPrivate: "restaurant-videos-private",
  videoPublic: "restaurant-videos",
} as const;

export type ManagedBucket =
  (typeof MANAGED_BUCKETS)[keyof typeof MANAGED_BUCKETS];

export function isManagedBucket(bucket: string): bucket is ManagedBucket {
  return (Object.values(MANAGED_BUCKETS) as string[]).includes(bucket);
}

/**
 * What each image status implies for the bytes that belong to it.
 *
 * `privateRetentionMs: null` means "never eligible on age" — the objects go
 * only when the lifecycle itself moves on. `publicExpected: false` is a
 * claim the planner checks rather than assumes: a public object found for
 * such a status is an accidental orphan, not a retained one.
 */
export interface StatusPolicy {
  /** A private original/variants are expected to exist. */
  privateExpected: boolean;
  /** Public variants legitimately exist for this status. */
  publicExpected: boolean;
  /** Time after status_changed_at before private bytes may go; null = never on age alone. */
  privateRetentionMs: number | null;
  /** Time before public bytes may go; null = never on age alone. */
  publicRetentionMs: number | null;
  /** Machine-readable reason attached to candidates from this status. */
  reason: string;
  /** Why, in one line, for the dry-run report and the docs. */
  rationale: string;
}

export const IMAGE_POLICY: Record<ImageStatus, StatusPolicy> = {
  active: {
    privateExpected: true,
    publicExpected: true,
    privateRetentionMs: null,
    publicRetentionMs: null,
    reason: "active_never_eligible",
    rationale:
      "This is the photo diners see. Nothing about it is ever cleaned up.",
  },
  pending_review: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: null,
    publicRetentionMs: null,
    reason: "pending_review_never_eligible",
    rationale:
      "Waiting on a person. An owner may take a week to look; that is not abandonment.",
  },
  uploading: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: RETENTION.incompleteStaleMs,
    publicRetentionMs: null,
    reason: "incomplete_abandoned",
    rationale: "Never reached a terminal state within the abandonment window.",
  },
  generating: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: RETENTION.incompleteStaleMs,
    publicRetentionMs: null,
    reason: "incomplete_abandoned",
    rationale:
      "Same as uploading. Phase 4 is not built; this exists so a future generation cannot leak bytes.",
  },
  failed: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: RETENTION.failedMs,
    publicRetentionMs: null,
    reason: "failed_retention_expired",
    rationale: "The original is kept as retry evidence for 30 days.",
  },
  rejected: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: RETENTION.rejectedMs,
    publicRetentionMs: null,
    reason: "rejected_retention_expired",
    rationale: "An owner declined it; kept 30 days in case they reconsider.",
  },
  superseded: {
    privateExpected: true,
    publicExpected: true,
    privateRetentionMs: RETENTION.supersededMs,
    publicRetentionMs: RETENTION.supersededMs,
    reason: "superseded_retention_expired",
    rationale:
      "Replaced. Public bytes may still be cached or in flight, so both areas wait 30 days.",
  },
  removed: {
    privateExpected: true,
    publicExpected: true,
    privateRetentionMs: RETENTION.removedMs,
    publicRetentionMs: RETENTION.removedMs,
    reason: "removed_retention_expired",
    rationale:
      "Taken down by an owner; same 30-day undo window as a replacement.",
  },
};

/** What each import status implies for its source pages. */
export const IMPORT_POLICY: Record<
  ImportStatus,
  { retentionMs: number | null; reason: string; rationale: string }
> = {
  uploaded: {
    retentionMs: RETENTION.importAbandonedMs,
    reason: "import_abandoned",
    rationale: "Authorized but extraction never ran; stale after a day.",
  },
  extracting: {
    retentionMs: RETENTION.importAbandonedMs,
    reason: "import_abandoned",
    rationale:
      "Extraction started and never finished — a crashed run, not work in progress, after a day.",
  },
  review: {
    retentionMs: null,
    reason: "import_in_review_never_eligible",
    rationale:
      "A person is reading the drafts; the photographs are what they check against.",
  },
  committed: {
    retentionMs: RETENTION.importSuccessMs,
    reason: "import_success_retention_expired",
    rationale:
      "The menu is already in menu_items; the pages are working material.",
  },
  failed: {
    retentionMs: RETENTION.importFailedMs,
    reason: "import_failed_retention_expired",
    rationale: "Kept a week for retry and diagnosis.",
  },
};

/**
 * What each hero video status implies for its objects.
 *
 * The same two-sided shape as IMAGE_POLICY: a video that was published
 * has objects on both sides, one that never was has objects only on the
 * private side, and `null` means "never eligible on age alone".
 */
export const HERO_VIDEO_POLICY: Record<HeroVideoStatus, StatusPolicy> = {
  active: {
    privateExpected: true,
    publicExpected: true,
    privateRetentionMs: null,
    publicRetentionMs: null,
    reason: "active_never_eligible",
    rationale: "This is the video diners see. Nothing about it is cleaned up.",
  },
  pending_review: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: null,
    publicRetentionMs: null,
    reason: "pending_review_never_eligible",
    rationale:
      "Waiting on a person to watch it. An owner may take a week; that is not abandonment.",
  },
  uploading: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: HERO_VIDEO_RETENTION.incompleteStaleMs,
    publicRetentionMs: null,
    reason: "hero_video_incomplete_abandoned",
    rationale:
      "Never finished. More likely here than for a photo: a hero video is up to 50 MB over restaurant wifi.",
  },
  failed: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: HERO_VIDEO_RETENTION.failedMs,
    publicRetentionMs: null,
    reason: "hero_video_failed_retention_expired",
    rationale: "The upload is kept as retry evidence for 30 days.",
  },
  rejected: {
    privateExpected: true,
    publicExpected: false,
    privateRetentionMs: HERO_VIDEO_RETENTION.rejectedMs,
    publicRetentionMs: null,
    reason: "hero_video_rejected_retention_expired",
    rationale:
      "An owner watched it and said no; kept 30 days in case they reconsider.",
  },
  superseded: {
    privateExpected: true,
    publicExpected: true,
    privateRetentionMs: HERO_VIDEO_RETENTION.supersededMs,
    publicRetentionMs: HERO_VIDEO_RETENTION.supersededMs,
    reason: "hero_video_superseded_retention_expired",
    rationale:
      "Replaced. A video may still be mid-download in an open tab, so both areas wait 30 days.",
  },
  removed: {
    privateExpected: true,
    publicExpected: true,
    privateRetentionMs: HERO_VIDEO_RETENTION.removedMs,
    publicRetentionMs: HERO_VIDEO_RETENTION.removedMs,
    reason: "hero_video_removed_retention_expired",
    rationale: "Taken down by an owner; the same 30-day undo window.",
  },
};

/**
 * `source` is provenance, not lifecycle. A real photo, an AI generation and
 * an unverified legacy image with the same status are cleaned identically.
 * Stated here because conflating the two is an easy and dangerous mistake.
 */
export const SOURCE_DOES_NOT_AFFECT_CLEANUP = true;
