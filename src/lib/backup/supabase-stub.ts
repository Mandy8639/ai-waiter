/**
 * The Supabase platform pieces PGlite has no equivalent of.
 *
 * Three places replay this project's real migrations into an in-memory
 * Postgres — the backup script, the backup verifier, and the integration
 * test harness — and every one of them first needs the bits Supabase
 * provides outside the migrations: the `auth` schema the policies read,
 * the `storage` schema the menu-import bucket lives in, and the roles the
 * migrations GRANT to.
 *
 * This module exists because that SQL used to be copy-pasted into all
 * three. When the storage bucket and `auth.users.is_anonymous` arrived,
 * only the test harness was updated, so `npm run db:backup` broke with
 * `relation "storage.buckets" does not exist` and stayed broken —
 * silently, because nobody runs a backup until they need one. The last
 * usable backup was nine days old by the time it surfaced.
 *
 * Only what the migrations actually touch is modelled. This is a
 * stand-in for applying migrations, not an emulation of Supabase.
 */

export const SUPABASE_PLATFORM_STUB_SQL = `
  create schema auth;

  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text unique,
    -- Real Supabase sets this for identities created via Anonymous Auth —
    -- every diner who scans a table's QR code. create_restaurant() reads
    -- it to refuse a guest session.
    is_anonymous boolean not null default false
  );

  create function auth.uid() returns uuid
  language sql stable as $$
    select nullif(current_setting('app.current_user_id', true), '')::uuid
  $$;

  -- Stubbed for the same reason auth is: the migrations reference it
  -- (menu-import uploads live in a bucket with its own RLS), and PGlite
  -- has no Supabase platform layer.
  create schema storage;

  create table storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );

  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    owner uuid,
    created_at timestamptz not null default now()
  );

  alter table storage.objects enable row level security;

  -- Matches Supabase's own helper: the path's folder segments, i.e.
  -- everything before the final '/'. The storage policies scope on [1],
  -- the restaurant id that namespaces each upload.
  create function storage.foldername(name text) returns text[]
  language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;

  create role authenticated nologin;
  create role anon nologin;
  -- The Stripe webhook writes as service_role, and migrations grant
  -- execute on the settlement functions to it specifically. Modelled with
  -- bypassrls, as on a real Supabase project.
  create role service_role nologin bypassrls;
`;
