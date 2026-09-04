-- A NULL-safety fix to an auth helper, first, because this feature is the
-- first thing to depend on it being safe.
--
-- is_restaurant_manager_or_owner() was:
--   select public.current_restaurant_role(x) in ('owner', 'manager')
-- and current_restaurant_role() returns NULL for a non-member. In SQL,
-- `NULL in ('owner','manager')` is NULL — not false.
--
-- That is harmless in an RLS USING clause, where NULL and false both deny
-- the row, which is why every existing use is fine and why this has never
-- bitten. It is NOT harmless in plpgsql: `if not <NULL> then` does not
-- take the branch, so an authorization guard written the obvious way
-- silently passes for a complete outsider. commit_menu_import() below is
-- the first function in this schema to guard with this helper, and it hit
-- exactly that — an outsider successfully committed an import in the
-- integration tests before this fix.
--
-- coalesce makes the helper return a real boolean. Behaviour under RLS is
-- unchanged (NULL and false deny identically); what changes is that
-- callers can now trust `not helper(...)`.
--
-- is_restaurant_member() is left alone: `... is not null` already returns
-- a true/false, never NULL, so the three existing plpgsql guards that use
-- it were never at risk.
create or replace function public.is_restaurant_manager_or_owner(target_restaurant_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    public.current_restaurant_role(target_restaurant_id) in ('owner', 'manager'),
    false
  )
$$;

comment on function public.is_restaurant_manager_or_owner(uuid) is
  'True if the calling user is an owner or manager of the given restaurant. Returns false (never NULL) for a non-member, so plpgsql guards written as `if not ...` behave correctly. Used to gate menu/table/settings management.';


-- Menu import from photographs of a restaurant's own menu boards.
--
-- A restaurant setting up AI Waiter should not have to type in 150 items by
-- hand. They photograph their boards, a vision model reads them, and a
-- human confirms the result before anything reaches the live menu.
--
-- That last clause is the whole design. Extraction is genuinely good — the
-- model this was built against read a dense board at 23/23 items with no
-- invented prices across three runs — but "genuinely good" is not "safe to
-- write into a live menu unattended". A menu is the price list a customer
-- is charged from. A single mis-read digit is a restaurant undercharging
-- for a month, and this project already has a documented incident of a
-- model confidently reporting an action it never performed (see
-- docs/ai.md#cart-grounding).
--
-- So extraction lands HERE, in staging, and a person promotes it. These
-- tables are the seam that makes that possible, and they are also why an
-- import can be abandoned, resumed, or re-run without touching menu_items.

create table public.menu_imports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  status text not null default 'uploaded',
  -- Storage object paths for the uploaded pages, in the order the user
  -- added them. Kept as an array rather than a child table because they
  -- are only ever read together, as one import's pages.
  source_paths text[] not null default '{}',
  -- Whatever the provider reported serving, so a bad import can be traced
  -- to a model rather than guessed at. Nullable: unset until extraction runs.
  extraction_model text,
  -- Customer-safe failure reason when status = 'failed'; never a raw stack.
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint menu_imports_status_valid
    check (status in ('uploaded', 'extracting', 'review', 'committed', 'failed')),
  constraint menu_imports_error_only_when_failed
    check (error is null or status = 'failed')
);

comment on table public.menu_imports is
  'One attempt at importing a menu from uploaded photographs. Extraction writes drafts to menu_import_items; nothing reaches menu_items until a human commits.';

create index menu_imports_restaurant_id_idx on public.menu_imports (restaurant_id, created_at desc);

create trigger trg_menu_imports_set_updated_at
  before update on public.menu_imports
  for each row
  execute function public.set_updated_at();

-- Draft rows. Deliberately NOT shaped like menu_items: price is NULLABLE
-- here where menu_items.price is NOT NULL, because "the board does not
-- give a price" is a real and common answer (Nashta's own boards had 14
-- such items) and the honest representation of it is null, not zero.
-- Committing is what forces the question to be answered.
create table public.menu_import_items (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.menu_imports (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  category_name text not null,
  name text not null,
  price numeric(10, 2),
  -- Set false by the reviewer for anything they do not want imported —
  -- a duplicate, a misread line, a discontinued dish.
  include boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint menu_import_items_name_not_blank check (length(trim(name)) > 0),
  constraint menu_import_items_category_not_blank check (length(trim(category_name)) > 0),
  constraint menu_import_items_price_non_negative check (price is null or price >= 0)
);

comment on table public.menu_import_items is
  'Extracted draft rows awaiting human review. price is nullable on purpose: a board that gives no price must be representable as "no price", never silently as 0.';

comment on column public.menu_import_items.price is
  'NULL means the board did not state a price. The commit path refuses to import a NULL-priced row rather than defaulting it — see commit_menu_import().';

create index menu_import_items_import_id_idx on public.menu_import_items (import_id, display_order);

create trigger trg_menu_import_items_set_updated_at
  before update on public.menu_import_items
  for each row
  execute function public.set_updated_at();

-- RLS ---------------------------------------------------------------------
-- Imports are staff-only, and manager-or-owner specifically: this writes the
-- restaurant's price list, which is not something kitchen or waiting staff
-- should be able to rewrite.

alter table public.menu_imports enable row level security;
alter table public.menu_import_items enable row level security;

create policy "menu_imports_manage_own_restaurant"
  on public.menu_imports
  for all
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

create policy "menu_import_items_manage_own_restaurant"
  on public.menu_import_items
  for all
  to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id))
  with check (public.is_restaurant_manager_or_owner(restaurant_id));

-- Storage -----------------------------------------------------------------
-- A private bucket. Menu photographs are a restaurant's own material and
-- can incidentally contain staff, handwriting, or internal notes, so
-- nothing here is publicly readable; the app reads them through signed URLs.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'menu-imports',
  'menu-imports',
  false,
  10485760, -- 10 MB per page: a phone photo of a board, not a scan archive
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- Objects are namespaced by restaurant id as the first path segment, which
-- is what these policies scope on. A member of one restaurant can never
-- read or write another's uploads.
create policy "menu_imports_storage_read_own_restaurant"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'menu-imports'
    and public.is_restaurant_manager_or_owner((storage.foldername(name))[1]::uuid)
  );

create policy "menu_imports_storage_write_own_restaurant"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'menu-imports'
    and public.is_restaurant_manager_or_owner((storage.foldername(name))[1]::uuid)
  );

create policy "menu_imports_storage_delete_own_restaurant"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'menu-imports'
    and public.is_restaurant_manager_or_owner((storage.foldername(name))[1]::uuid)
  );

-- Commit ------------------------------------------------------------------

create or replace function public.commit_menu_import(p_import_id uuid)
returns table (categories_created integer, items_created integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_restaurant_id uuid;
  v_status text;
  v_unpriced integer;
  v_cats integer := 0;
  v_items integer := 0;
  v_row record;
  v_category_id uuid;
  v_next_order integer;
begin
  select restaurant_id, status into v_restaurant_id, v_status
  from public.menu_imports where id = p_import_id;

  if not found then
    raise exception 'MENU_IMPORT_NOT_FOUND';
  end if;

  -- SECURITY DEFINER bypasses RLS, so the caller's right to write this
  -- restaurant's price list is checked explicitly rather than assumed.
  if not public.is_restaurant_manager_or_owner(v_restaurant_id) then
    raise exception 'MENU_IMPORT_FORBIDDEN';
  end if;

  if v_status = 'committed' then
    -- Not an error worth alarming anyone with, but it must not run twice:
    -- a second run would duplicate every item.
    raise exception 'MENU_IMPORT_ALREADY_COMMITTED';
  end if;

  if v_status <> 'review' then
    raise exception 'MENU_IMPORT_NOT_READY';
  end if;

  -- The rule the nullable price column exists to enforce. A board that
  -- gave no price cannot be silently imported at 0.00 — someone has to
  -- supply the real one, or exclude the row.
  select count(*) into v_unpriced
  from public.menu_import_items
  where import_id = p_import_id and include = true and price is null;

  if v_unpriced > 0 then
    raise exception 'MENU_IMPORT_UNPRICED_ITEMS';
  end if;

  for v_row in
    select category_name, name, price, display_order
    from public.menu_import_items
    where import_id = p_import_id and include = true
    order by display_order, name
  loop
    select id into v_category_id
    from public.categories
    where restaurant_id = v_restaurant_id and name = v_row.category_name;

    if v_category_id is null then
      select coalesce(max(display_order), 0) + 1 into v_next_order
      from public.categories where restaurant_id = v_restaurant_id;

      insert into public.categories (restaurant_id, name, display_order)
      values (v_restaurant_id, v_row.category_name, v_next_order)
      returning id into v_category_id;

      v_cats := v_cats + 1;
    end if;

    -- Slug is derived here rather than trusted from the draft: it is
    -- structural, not something a reviewer should be able to mistype into
    -- a collision.
    insert into public.menu_items (
      restaurant_id, category_id, name, slug, price, display_order
    )
    values (
      v_restaurant_id,
      v_category_id,
      v_row.name,
      trim(both '-' from regexp_replace(lower(v_row.name), '[^a-z0-9]+', '-', 'g')),
      v_row.price,
      v_row.display_order
    );

    v_items := v_items + 1;
  end loop;

  update public.menu_imports
  set status = 'committed', error = null
  where id = p_import_id;

  categories_created := v_cats;
  items_created := v_items;
  return next;
end;
$$;

comment on function public.commit_menu_import(uuid) is
  'Promotes a reviewed import into the live menu. Refuses to run twice, refuses a caller who is not a manager/owner, and refuses any included row with no price rather than defaulting it to zero.';

revoke execute on function public.commit_menu_import(uuid) from public;
grant execute on function public.commit_menu_import(uuid) to authenticated;
