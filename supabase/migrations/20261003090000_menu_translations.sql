-- Menu translation (phase K): dish names, dish descriptions and category
-- names in Hindi, Spanish, Gujarati and Telugu.
--
-- THE RULES
--
--   1. NOTHING REACHES A DINER UNREVIEWED. A translation is a draft until
--      an owner or manager approves it. The AI may write drafts; only a
--      person can approve one. get_menu_translations() returns approved
--      translations only.
--
--   2. A TRANSLATION OF OLD TEXT IS NOT SHOWN. Each translation remembers a
--      hash of the original it was made from (source_hash). When the owner
--      edits the dish, the hashes stop matching, the translation stops
--      being served, and the translations screen marks it "original
--      changed" until someone re-approves it against the new text. Staleness
--      is computed on read, so no edit path has to remember to flag it.
--
--   3. SAFETY TEXT IS NOT IN HERE. Allergens and dietary labels come from
--      structured data and are shown in English with a fixed glossary
--      translation beside them (src/lib/translations/glossary.ts) — never
--      from this table and never from the AI.
--
-- The original (usually English) text is always the source of truth; a
-- diner can always see it.

create function public.menu_translation_hash(p_text text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(sha256(convert_to(coalesce(p_text, ''), 'UTF8')), 'hex')
$$;

revoke execute on function public.menu_translation_hash(text) from public, anon;
grant execute on function public.menu_translation_hash(text) to authenticated;

create table public.menu_translations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  entity text not null,
  entity_id uuid not null,
  field text not null,
  language text not null,
  text text not null,
  source_hash text not null,
  status text not null default 'draft',
  origin text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,

  constraint menu_translations_one_per_field unique (entity, entity_id, field, language),
  constraint menu_translations_entity_valid check (entity in ('menu_item', 'category')),
  constraint menu_translations_field_valid check (
    (entity = 'menu_item' and field in ('name', 'description'))
    or (entity = 'category' and field = 'name')
  ),
  constraint menu_translations_language_valid check (language in ('hi', 'es', 'gu', 'te')),
  constraint menu_translations_text_length check (char_length(btrim(text)) between 1 and 1000),
  constraint menu_translations_status_valid check (status in ('draft', 'approved')),
  constraint menu_translations_origin_valid check (origin in ('ai', 'owner')),
  constraint menu_translations_approval_consistent
    check ((status = 'approved') = (approved_at is not null))
);

create index menu_translations_restaurant_language_idx
  on public.menu_translations (restaurant_id, language);

comment on table public.menu_translations is
  'Phase K: reviewed translations of dish names/descriptions and category names. Served to diners only when approved AND made from the current original (source_hash). See docs/security.md#menu-translation-phase-k.';

alter table public.menu_translations enable row level security;

create policy "menu_translations_select_members"
  on public.menu_translations for select to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- Writes go through save/approve below, which compute the hash from the
-- database's own copy of the original. Owners and managers may delete
-- (reject) a translation directly.
create policy "menu_translations_delete_owner_manager"
  on public.menu_translations for delete to authenticated
  using (public.is_restaurant_manager_or_owner(restaurant_id));

-- The current original of a translatable field, or null if it doesn't
-- exist or doesn't belong to the restaurant.
create function public.menu_translation_source(
  p_restaurant_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_field text
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_entity = 'menu_item' and p_field = 'name' then (
      select mi.name from public.menu_items mi
      where mi.id = p_entity_id and mi.restaurant_id = p_restaurant_id)
    when p_entity = 'menu_item' and p_field = 'description' then (
      select nullif(btrim(mi.description), '') from public.menu_items mi
      where mi.id = p_entity_id and mi.restaurant_id = p_restaurant_id)
    when p_entity = 'category' and p_field = 'name' then (
      select c.name from public.categories c
      where c.id = p_entity_id and c.restaurant_id = p_restaurant_id)
  end
$$;

revoke execute on function public.menu_translation_source(uuid, text, uuid, text) from public, anon, authenticated;

-- Save a draft, from the AI or typed by a person. Always a draft: saving
-- never publishes. Made from the current original, which is read here.
create function public.save_menu_translation(
  target_restaurant_id uuid,
  p_entity text,
  p_entity_id uuid,
  p_field text,
  p_language text,
  p_text text,
  p_origin text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text;
  v_id uuid;
begin
  if not public.is_restaurant_manager_or_owner(target_restaurant_id) then
    raise exception 'TRANSLATION_FORBIDDEN: only an owner or manager can edit translations'
      using errcode = '42501';
  end if;

  v_source := public.menu_translation_source(target_restaurant_id, p_entity, p_entity_id, p_field);
  if v_source is null then
    raise exception 'TRANSLATION_NO_SOURCE: there is nothing to translate there'
      using errcode = 'P0002';
  end if;

  insert into public.menu_translations as t
    (restaurant_id, entity, entity_id, field, language, text, source_hash, status, origin)
  values (
    target_restaurant_id, p_entity, p_entity_id, p_field, p_language,
    btrim(p_text), public.menu_translation_hash(v_source), 'draft', p_origin
  )
  on conflict (entity, entity_id, field, language) do update
  set text = excluded.text,
      source_hash = excluded.source_hash,
      status = 'draft',
      origin = excluded.origin,
      approved_at = null,
      approved_by = null,
      updated_at = now()
  returning t.id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.save_menu_translation(uuid, text, uuid, text, text, text, text) from public, anon;
grant execute on function public.save_menu_translation(uuid, text, uuid, text, text, text, text) to authenticated;

-- A person approves a translation as correct for the CURRENT original. The
-- hash is re-taken here, so approving an "original changed" translation
-- means approving it against the text that is there now.
create function public.approve_menu_translation(p_translation_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.menu_translations%rowtype;
  v_source text;
begin
  select * into v_row from public.menu_translations t where t.id = p_translation_id;
  if not found then
    raise exception 'TRANSLATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.is_restaurant_manager_or_owner(v_row.restaurant_id) then
    raise exception 'TRANSLATION_FORBIDDEN: only an owner or manager can approve translations'
      using errcode = '42501';
  end if;

  v_source := public.menu_translation_source(v_row.restaurant_id, v_row.entity, v_row.entity_id, v_row.field);
  if v_source is null then
    raise exception 'TRANSLATION_NO_SOURCE: the original is gone' using errcode = 'P0002';
  end if;

  update public.menu_translations
  set status = 'approved',
      approved_at = now(),
      approved_by = auth.uid(),
      source_hash = public.menu_translation_hash(v_source),
      updated_at = now()
  where id = p_translation_id;
end;
$$;

revoke execute on function public.approve_menu_translation(uuid) from public, anon;
grant execute on function public.approve_menu_translation(uuid) to authenticated;

-- What a diner sees: approved translations made from the current original,
-- for an active restaurant. The menu is public, so this is too.
create function public.get_menu_translations(target_restaurant_id uuid, p_language text)
returns table (
  translated_entity text,
  translated_entity_id uuid,
  translated_field text,
  translated_text text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.entity, t.entity_id, t.field, t.text
  from public.menu_translations t
  join public.restaurants r on r.id = t.restaurant_id
  where t.restaurant_id = target_restaurant_id
    and r.is_active
    and t.language = p_language
    and t.status = 'approved'
    and t.source_hash = public.menu_translation_hash(
      public.menu_translation_source(t.restaurant_id, t.entity, t.entity_id, t.field))
$$;

revoke execute on function public.get_menu_translations(uuid, text) from public;
grant execute on function public.get_menu_translations(uuid, text) to anon, authenticated;

-- Which languages a diner can switch the menu into: any with at least one
-- current, approved translation.
create function public.get_menu_languages(target_restaurant_id uuid)
returns table (menu_language text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct t.language
  from public.menu_translations t
  join public.restaurants r on r.id = t.restaurant_id
  where t.restaurant_id = target_restaurant_id
    and r.is_active
    and t.status = 'approved'
    and t.source_hash = public.menu_translation_hash(
      public.menu_translation_source(t.restaurant_id, t.entity, t.entity_id, t.field))
  order by 1
$$;

revoke execute on function public.get_menu_languages(uuid) from public;
grant execute on function public.get_menu_languages(uuid) to anon, authenticated;

-- A deleted dish or category takes its translations with it.
create function public.delete_entity_translations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.menu_translations t
  where t.entity = tg_argv[0] and t.entity_id = old.id;
  return old;
end;
$$;

revoke execute on function public.delete_entity_translations() from public, anon, authenticated;

create trigger menu_items_delete_translations
  after delete on public.menu_items
  for each row execute function public.delete_entity_translations('menu_item');

create trigger categories_delete_translations
  after delete on public.categories
  for each row execute function public.delete_entity_translations('category');
