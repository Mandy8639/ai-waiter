import type { ImageStatus, ImportStatus, ManagedBucket } from "./policy";

/**
 * The inputs and outputs of cleanup planning.
 *
 * Everything the planner needs is passed in, so the planning stage is a
 * pure function of (database state, storage inventory, now). That is what
 * makes retention decisions testable without a clock, a database or a
 * storage service.
 */

/** One menu_item_images row, reduced to what cleanup needs. */
export interface ImageRecord {
  id: string;
  restaurantId: string;
  menuItemId: string;
  status: ImageStatus;
  /** When it entered that status — the clock every retention window runs from. */
  statusChangedAt: Date;
  originalPath: string | null;
  variantPaths: Record<string, string> | null;
}

/** menu_items, reduced to the one field that can veto a deletion. */
export interface MenuItemRecord {
  id: string;
  activeImageId: string | null;
}

/** One menu_imports row. */
export interface ImportRecord {
  id: string;
  restaurantId: string;
  status: ImportStatus;
  sourcePaths: string[];
  /** Last lifecycle movement; retention runs from here. */
  updatedAt: Date;
}

/** One object as Storage reports it. Never authoritative on its own. */
export interface StorageObject {
  bucket: string;
  path: string;
  sizeBytes: number | null;
  createdAt: Date;
}

export interface CleanupInput {
  now: Date;
  images: ImageRecord[];
  menuItems: MenuItemRecord[];
  imports: ImportRecord[];
  objects: StorageObject[];
}

/** Why an object may go. Machine-readable so a report can be diffed run to run. */
export type CleanupReason =
  | "incomplete_abandoned"
  | "failed_retention_expired"
  | "rejected_retention_expired"
  | "superseded_retention_expired"
  | "removed_retention_expired"
  | "public_orphan_expired"
  | "private_orphan_expired"
  | "import_abandoned"
  | "import_success_retention_expired"
  | "import_failed_retention_expired"
  | "import_orphan_expired";

/** Why an object was left alone. Reported, because silence hides bugs. */
export type SkipReason =
  | "active_never_eligible"
  | "referenced_as_active_image"
  | "pending_review_never_eligible"
  | "import_in_review_never_eligible"
  | "within_retention"
  | "within_safety_window"
  | "malformed_path"
  | "path_does_not_match_owning_record"
  | "unknown_object_report_only"
  | "unmanaged_bucket";

export interface CleanupCandidate {
  kind: "menu_photo" | "menu_import";
  /** The owning row, when there is one. Null only for true orphans. */
  imageId?: string | null;
  importId?: string | null;
  bucket: ManagedBucket;
  path: string;
  reason: CleanupReason;
  /** How old the owning lifecycle state is, in ms. */
  ageMs: number;
  /** The instant it became eligible. Always <= now for a candidate. */
  safeAfter: Date;
  sizeBytes: number | null;
  destructive: true;
}

export interface CleanupSkip {
  bucket: string;
  path: string;
  reason: SkipReason;
  imageId?: string | null;
  importId?: string | null;
  /** For within_retention / within_safety_window: when it would become eligible. */
  eligibleAt?: Date;
}

export interface CleanupPlan {
  now: Date;
  candidates: CleanupCandidate[];
  skips: CleanupSkip[];
  /** Totals for the report; sizes are null-tolerant. */
  summary: {
    objectsConsidered: number;
    eligible: number;
    skipped: number;
    reclaimableBytes: number;
    byReason: Record<string, number>;
  };
}

/** The deletion surface. Deliberately tiny, and never a full storage client. */
export interface CleanupStorage {
  remove(bucket: string, paths: string[]): Promise<void>;
}

export interface ExecuteOptions {
  /** Nothing is deleted unless this is explicitly true. */
  execute?: boolean;
  batchLimit?: number;
}

export interface ExecuteResult {
  dryRun: boolean;
  attempted: number;
  deleted: string[];
  failed: Array<{ bucket: string; path: string; error: string }>;
  /** Candidates left over because the batch limit was reached. */
  remaining: number;
  /** Candidates dropped at execution time because revalidation refused them. */
  refused: Array<{ bucket: string; path: string; reason: string }>;
}
