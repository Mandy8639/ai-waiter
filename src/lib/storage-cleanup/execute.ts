import { DEFAULT_BATCH_LIMIT, isManagedBucket } from "./policy";
import { parseImportPath, parsePhotoPath } from "./plan";
import type {
  CleanupCandidate,
  CleanupPlan,
  CleanupStorage,
  ExecuteOptions,
  ExecuteResult,
} from "./types";

/**
 * Stage 2: delete exactly the objects the plan approved, and nothing else.
 *
 * Kept apart from planning on purpose. A single loop that decides and
 * deletes in one pass is impossible to review, because the decision is
 * never written down anywhere a person can read before the bytes are gone.
 *
 * Three properties matter more than throughput:
 *
 *   DRY RUN IS THE DEFAULT. `execute` must be explicitly true. A caller
 *   that forgets the flag reports and deletes nothing.
 *
 *   EVERY CANDIDATE IS REVALIDATED HERE. The plan is re-checked against the
 *   same path rules before the delete call, so a candidate that was
 *   hand-edited, deserialized from an old run, or produced by a planner bug
 *   still cannot name an arbitrary object. Refusals are reported, not
 *   swallowed.
 *
 *   PARTIAL FAILURE IS NORMAL. Objects are deleted one at a time and a
 *   failure is recorded and stepped over, never retried in place and never
 *   allowed to abort the run. Nothing about the database is touched, so the
 *   next run recomputes the same state and simply finds fewer objects left.
 *   That is what makes the whole thing idempotent.
 */

/** Why the executor refused a candidate the planner produced. */
function revalidate(candidate: CleanupCandidate): string | null {
  if (!candidate.destructive) return "not_marked_destructive";
  if (!isManagedBucket(candidate.bucket)) return "unmanaged_bucket";

  if (candidate.kind === "menu_photo") {
    const parsed = parsePhotoPath(candidate.path);
    if (!parsed) return "malformed_photo_path";
    // A candidate naming an image must name it in its own folder.
    if (candidate.imageId && parsed.imageId !== candidate.imageId) {
      return "path_image_id_mismatch";
    }
    return null;
  }

  const parsed = parseImportPath(candidate.path);
  if (!parsed) return "malformed_import_path";
  if (candidate.importId && parsed.importId !== candidate.importId) {
    return "path_import_id_mismatch";
  }
  return null;
}

export async function executeCleanup(
  plan: CleanupPlan,
  storage: CleanupStorage,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const batchLimit = options.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const dryRun = options.execute !== true;

  const refused: ExecuteResult["refused"] = [];
  const approved: CleanupCandidate[] = [];
  for (const candidate of plan.candidates) {
    const reason = revalidate(candidate);
    if (reason) {
      refused.push({
        bucket: candidate.bucket,
        path: candidate.path,
        reason,
      });
      continue;
    }
    approved.push(candidate);
  }

  const batch = approved.slice(0, batchLimit);
  const remaining = approved.length - batch.length;

  if (dryRun) {
    return {
      dryRun: true,
      attempted: 0,
      deleted: [],
      failed: [],
      remaining: approved.length,
      refused,
    };
  }

  const deleted: string[] = [];
  const failed: ExecuteResult["failed"] = [];

  // One object per call. Slower than a bulk remove, and worth it: a bulk
  // failure tells you nothing about which of twenty objects survived, and
  // this runs rarely on a small number of objects.
  for (const candidate of batch) {
    try {
      await storage.remove(candidate.bucket, [candidate.path]);
      deleted.push(`${candidate.bucket}:${candidate.path}`);
    } catch (error) {
      failed.push({
        bucket: candidate.bucket,
        path: candidate.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    dryRun: false,
    attempted: batch.length,
    deleted,
    failed,
    remaining,
    refused,
  };
}

/** A human-readable dry-run report. The candidates are the point; the skips are the safety argument. */
export function formatPlan(plan: CleanupPlan, result?: ExecuteResult): string {
  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  const lines: string[] = [];
  lines.push(`storage cleanup plan @ ${plan.now.toISOString()}`);
  lines.push(
    `  considered ${plan.summary.objectsConsidered}, eligible ${plan.summary.eligible}, skipped ${plan.summary.skipped}, reclaimable ${mb(plan.summary.reclaimableBytes)}`,
  );

  if (plan.candidates.length > 0) {
    lines.push("  eligible:");
    for (const c of plan.candidates) {
      lines.push(
        `    ${c.bucket}/${c.path}  ${c.reason}  age=${Math.floor(c.ageMs / 86400000)}d  ${c.sizeBytes ? mb(c.sizeBytes) : "size unknown"}`,
      );
    }
  }

  // Grouped, because a per-object list of a thousand retained photos is
  // noise — but a reason that appears unexpectedly is a signal.
  const skipCounts = new Map<string, number>();
  for (const s of plan.skips) {
    skipCounts.set(s.reason, (skipCounts.get(s.reason) ?? 0) + 1);
  }
  if (skipCounts.size > 0) {
    lines.push("  skipped:");
    for (const [reason, count] of [...skipCounts].sort()) {
      lines.push(`    ${String(count).padStart(4)}  ${reason}`);
    }
  }

  if (result) {
    lines.push(
      result.dryRun
        ? `  DRY RUN — nothing deleted. ${result.remaining} object(s) would be removed; pass --execute to do it.`
        : `  EXECUTED — deleted ${result.deleted.length}, failed ${result.failed.length}, remaining ${result.remaining}`,
    );
    for (const f of result.failed) {
      lines.push(`    FAILED ${f.bucket}/${f.path}: ${f.error}`);
    }
    for (const r of result.refused) {
      lines.push(`    REFUSED ${r.bucket}/${r.path}: ${r.reason}`);
    }
    if (result.remaining > 0 && !result.dryRun) {
      lines.push("  continuation required: run again to process the rest.");
    }
  }
  return lines.join("\n");
}
