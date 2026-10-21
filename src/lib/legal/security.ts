/**
 * The security page (src/app/security/page.tsx): plain answers for a
 * restaurant owner who asks how their data is handled. Linked from the
 * landing footer and Settings → Your data.
 *
 * EVERY SENTENCE THERE MUST BE TRUE TODAY. In particular it says nothing
 * about backups until the production database has scheduled backups
 * (docs/backup-and-restore.md: the Free plan has none). When Supabase Pro is
 * on, set this to true and the page gains its backups paragraph.
 */
export const SECURITY_PATH = "/security";

export const HAS_SCHEDULED_BACKUPS = false;
