# Backup and restore

## The situation, stated plainly

**The production Supabase project is on the Free plan, which includes no backups.**

- **Scheduled backups** — "Free Plan does not include project backups." Daily backups with 7-day
  retention start at the Pro plan.
- **Point-in-time recovery** — a Pro add-on starting at $100/month.

So as things stand there is nothing to restore from. A dropped table, a bad migration, or an
account problem loses every restaurant, menu, order, payment record and reservation permanently.
The schema is reproducible from `supabase/migrations/`; the data is not reproducible from
anything.

The two ways to fix that are not alternatives — the first is a real dependency on a vendor button
nobody here has ever pressed, and the second is a file you hold and have actually restored:

1. **Upgrade to Pro** for managed daily backups.
2. **Run the logical backup below**, which exists precisely because (1) currently isn't true.

## Taking a backup

```bash
npm run db:backup
```

Read-only against production. Writes one timestamped JSON file to `backups/` (gitignored) holding
every row of every `public` table.

The table list is **not** hand-maintained. It is read from the schema the migrations actually
produce, by applying `supabase/migrations/` to a throwaway in-memory PGlite instance and asking it
what exists. A table added by a future migration is therefore included automatically, instead of
being quietly missed by a backup that still reports success.

Rows are paged, because a plain PostgREST select stops at its row limit and a backup that silently
truncates at 1,000 rows is worse than no backup at all.

## Verifying a backup

```bash
npm run db:verify-backup                 # newest file in backups/
npm run db:verify-backup -- <path.json>  # a specific one
```

**An unverified backup is not a backup.** This restores the file into a throwaway in-memory
Postgres with the real migrations applied, then checks every table came back with the row count it
went in with. It touches no real database, needs no credentials, and costs nothing to run as often
as the backup itself.

Foreign keys stay **enforced** for the whole restore. Only user triggers are disabled (`disable
trigger user`, which is what `pg_restore` does), never `session_replication_role` — that the
restored data satisfies every foreign key is the most valuable thing this check proves, and
switching FK enforcement off would make a passing run mean very little.

### What verifying it actually caught

The first run failed on **17 of 33 tables**, restoring 650 of 1,574 rows. All four causes were
real, and none would have been visible without attempting the restore:

| Cause                                                 | Example                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Migrations seed some tables, so restored rows collide | `platform_plans` duplicate slug                                           |
| Generated columns reject an inserted value            | `audit_log.seq`, `order_payments.total_amount`                            |
| Foreign keys into `auth.users` beyond the obvious one | `customer_sessions.user_id` (anonymous diners), `reservations.created_by` |
| Audit triggers firing during the load                 | `audit_log` came back with 801 rows where the backup held 348             |

Each is handled now — tables cleared first so the backup is authoritative rather than additive,
generated columns discovered and skipped, every `auth.users`-referencing column discovered rather
than hardcoded, and user triggers disabled for the load. Current result: **1,574 of 1,574 rows,
every table matching.**

### Found 2026-10-17: the backup had silently shrunk to 3 tables

`npm run db:backup` exported **3 of 61 tables (41 rows)** and only printed a warning. Two cycles
between tables had appeared since the last check:

- `restaurants.active_hero_video_id` → `restaurant_hero_videos` (20260923090000);
- `menu_items (active_image_id, id)` → `menu_item_images` (20260919100000).

The table ordering stopped at the first cycle, and the export covered only what it had ordered,
which dropped every table that depends on `restaurants`.

Now (`src/lib/backup/schema-order.ts`, `introspect.ts`):

- **Every table is always exported.**
- A cycle is broken at a key that can be left empty. A multi-column key counts as optional if any
  of its columns is nullable, since Postgres doesn't check it then.
- The restore inserts those columns empty, together with any column a CHECK ties to them
  (`image_source`, `hero_video`), and fills them in with one UPDATE once every table is in.
- `tests/integration/db/backup-table-order.test.ts` fails if any table is missing from the order.

Result: **6,099 of 6,099 rows across 61 tables**, every table matching.

## ⚠️ The gap: this backup does not include logins

The backup covers the `public` schema only. Supabase's `auth` schema — the actual user accounts
and their credentials — is not reachable through PostgREST and is **not in the file**, even though
six public columns hold foreign keys into it:

```
restaurant_users.user_id        customer_sessions.user_id
reservations.created_by         payment_refunds.created_by
order_payments.recorded_by      order_payments.reversed_by
```

Restoring this backup alone brings back every restaurant, menu, order and payment record — and
nobody can log in. The verification script seeds placeholder `auth.users` rows so the rest of the
restore can be checked, and says so on every run rather than letting a green result imply more
than it should.

Closing that gap needs either a Pro-plan managed backup (which covers the whole database) or a
separate export of the auth users via the Admin API. **It is not closed today.**

## Restoring for real

There is no "restore" script on purpose. Writing 1,500 rows into a live project is not something
that should be one command away, and the right procedure depends on what went wrong — a dropped
table is not the same as a corrupted one, and neither is the same as a lost project.

What is verified is that the data in the file is complete and consistent enough to be restored:
it satisfies every foreign key and every constraint the real migrations define. The mechanics of
getting it into a live project — a fresh project plus `supabase db push` plus a load, versus a
targeted repair of one table — is a decision to make with the failure in front of you.

## A reasonable routine

- `npm run db:backup` before any migration that drops or rewrites data, and on a schedule you can
  live with losing the gap between.
- `npm run db:verify-backup` straight after, every time. It takes seconds.
- Keep the files somewhere that is not this laptop.
