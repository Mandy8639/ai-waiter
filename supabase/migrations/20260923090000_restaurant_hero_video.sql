-- Restaurant hero video (phase 4B)
--
-- One short video per restaurant, shown at the top of the diner menu.
--
-- THE SHAPE IS DELIBERATELY THE SAME AS menu_item_images. Every rule that
-- made photos safe applies here for the same reasons, so the vocabulary is
-- identical rather than merely similar:
--
--   * every upload is a NEW row; rows are never overwritten, so a path is
--     never reused and a published object never has to be invalidated;
--   * an upload stops at 'pending_review'. Only publish_restaurant_hero_video()
--     reaches 'active', and only a person calls it;
--   * the restaurants pointer columns are written by these functions alone,
--     enforced by a trigger, because RLS lets an owner update any other
--     column of their own restaurant;
--   * paths are validated against the same allow-list as menu images.
--
-- WHAT IS DIFFERENT, AND WHY IT MATTERS
--
-- There is no ffmpeg in this system and none is being added. That has three
-- consequences, all of them recorded here rather than discovered later:
--
--   1. The video is stored exactly as uploaded. It is never transcoded, so
--      what a diner downloads is the file the restaurant chose. The bucket's
--      MIME allow-list and a container-signature check in the application
--      are the whole of the validation.
--   2. Duration, dimensions and codec are UNKNOWN and therefore not stored.
--      This schema has no duration_seconds column on purpose: a column that
--      could only ever hold a guess is worse than no column.
--   3. The poster frame cannot be extracted from the video, so the owner
--      uploads one. It is a real image and goes through the same sharp
--      pipeline as a dish photo, which is why poster_paths looks exactly
--      like menu_item_images.variant_paths.
--
-- The poster is REQUIRED, not optional. The diner UI shows a still and only
-- downloads the video when tapped (a hungry person on restaurant wifi should
-- not pay several megabytes for a decoration), and a tap-to-play control
-- with no still is a grey box.

-- Buckets -------------------------------------------------------------------
--
-- Separate from the menu photo buckets so that a path in either one is
-- unambiguous about what it is — the retention engine parses paths, and a
-- bucket whose contents could be two different lifecycles is a bucket whose
-- cleanup rules cannot be stated simply.
--
-- Zero policies, as with menu-photos: a private bucket with no policy is
-- reachable only through a signed token or the service role, which is
-- exactly the property that makes an unreviewed upload unreachable.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-videos-private',
  'restaurant-videos-private',
  false,
  -- 50 MB. A ten-to-thirty second hero clip at 1080p is 3-10 MB; this
  -- leaves room for a phone's high-bitrate export without inviting someone
  -- to upload a feature film.
  52428800,
  array[
    'video/mp4',
    'video/webm',
    -- The poster original, before sharp processes it.
    'image/jpeg',
    'image/png',
    'image/webp'
  ]
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'restaurant-videos',
  'restaurant-videos',
  true,
  52428800,
  -- The published side carries the untranscoded video and WebP posters only.
  array['video/mp4', 'video/webm', 'image/webp']
)
on conflict (id) do nothing;

-- The videos ----------------------------------------------------------------

create table public.restaurant_hero_videos (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,

  status text not null default 'uploading',
  status_changed_at timestamptz not null default now(),

  -- Relative to the bucket, and always inside this video's own folder:
  -- {restaurant}/{video}/. Which bucket depends on status, exactly as it
  -- does for menu images.
  video_path text,
  poster_paths jsonb,

  -- Recorded from the bytes that actually arrived, never from what the
  -- client claimed. No duration or dimensions: see the header.
  byte_size integer,
  mime_type text,
  content_sha256 text,

  error text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint restaurant_hero_videos_status_valid check (
    status in (
      'uploading', 'pending_review', 'active',
      'superseded', 'rejected', 'removed', 'failed'
    )
  ),
  -- Anything past 'uploading' must know where its bytes are. A row claiming
  -- to be reviewable without a video or a poster is the state the diner UI
  -- cannot render.
  constraint restaurant_hero_videos_paths_once_ready check (
    status in ('uploading', 'failed')
    or (video_path is not null and poster_paths is not null)
  ),
  constraint restaurant_hero_videos_mime_valid check (
    mime_type is null or mime_type in ('video/mp4', 'video/webm')
  ),
  constraint restaurant_hero_videos_error_only_when_failed check (
    error is null or status = 'failed'
  )
);

comment on table public.restaurant_hero_videos is
  'One row per hero video upload, never overwritten. The video is stored untranscoded; poster_paths holds sharp-processed WebP stills because a poster frame cannot be extracted without ffmpeg.';

-- One live video per restaurant, and one upload in flight at a time. The
-- second is not a performance guard: it stops an owner from queueing three
-- uploads and then wondering which one they are approving.
create unique index restaurant_hero_videos_one_active
  on public.restaurant_hero_videos (restaurant_id)
  where status = 'active';

create unique index restaurant_hero_videos_one_in_flight
  on public.restaurant_hero_videos (restaurant_id)
  where status in ('uploading', 'pending_review');

create index restaurant_hero_videos_restaurant_idx
  on public.restaurant_hero_videos (restaurant_id, created_at desc);

create trigger trg_restaurant_hero_videos_set_updated_at
  before update on public.restaurant_hero_videos
  for each row
  execute function public.set_updated_at();

-- status_changed_at is what the retention engine measures against, so it
-- must move when and only when the status moves.
create or replace function public.restaurant_hero_videos_track_status_change()
returns trigger
language plpgsql
as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger trg_restaurant_hero_videos_track_status_change
  before update on public.restaurant_hero_videos
  for each row
  execute function public.restaurant_hero_videos_track_status_change();

alter table public.restaurant_hero_videos enable row level security;

-- Members only, like menu_item_images: an unreviewed video is staff
-- material. Diners never read this table — they read the denormalised
-- columns on restaurants, which is why those exist.
create policy "restaurant_hero_videos_select_members"
  on public.restaurant_hero_videos
  for select
  to authenticated
  using (public.is_restaurant_member(restaurant_id));

-- No insert, update or delete policy at all. Every write goes through the
-- SECURITY DEFINER functions below.

-- What the diner sees -------------------------------------------------------
--
-- restaurants is publicly selectable (20260822090100_public_storefront_rls),
-- so the active video is denormalised onto it. Same reasoning as
-- menu_items.image_variants: the lifecycle table is members-only, and a
-- diner needs the paths without being able to see the history.

alter table public.restaurants
  add column active_hero_video_id uuid
    references public.restaurant_hero_videos (id) on delete set null,
  add column hero_video jsonb;

comment on column public.restaurants.hero_video is
  'Denormalised copy of the active hero video for diners: {"video": "path", "poster": {"small": "path", ...}}. Written only by the hero video functions.';

alter table public.restaurants
  add constraint restaurants_hero_video_pointer_consistent
    check ((active_hero_video_id is null) = (hero_video is null));

-- RLS lets an owner or manager update any column of their own restaurant,
-- so without this a direct update could point the hero at another
-- restaurant's object, or resurrect a rejected video. Column privileges
-- cannot express this on Supabase (authenticated holds a table-wide UPDATE
-- grant that a column REVOKE does not override), so a trigger does — the
-- same approach as menu_items_guard_image_columns().
create or replace function public.restaurants_guard_hero_video_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.active_hero_video_id is not null or new.hero_video is not null then
        raise exception 'RESTAURANT_HERO_VIDEO_COLUMNS_READ_ONLY';
      end if;
    elsif new.active_hero_video_id is distinct from old.active_hero_video_id
      or new.hero_video is distinct from old.hero_video then
      raise exception 'RESTAURANT_HERO_VIDEO_COLUMNS_READ_ONLY';
    end if;
  end if;
  return new;
end;
$$;

comment on function public.restaurants_guard_hero_video_columns() is
  'Refuses direct writes to restaurants.active_hero_video_id / hero_video from request roles. Only the hero video functions may change which video a restaurant shows.';

create trigger trg_restaurants_guard_hero_video_columns
  before insert or update on public.restaurants
  for each row
  execute function public.restaurants_guard_hero_video_columns();

-- Authorization -------------------------------------------------------------

create or replace function public.hero_video_authorize(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_restaurant_manager_or_owner(p_restaurant_id) then
    raise exception 'HERO_VIDEO_FORBIDDEN';
  end if;
end;
$$;

create or replace function public.hero_video_authorize_video(p_video_id uuid)
returns public.restaurant_hero_videos
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.restaurant_hero_videos;
begin
  select * into v_video from public.restaurant_hero_videos where id = p_video_id;
  if v_video.id is null then
    raise exception 'HERO_VIDEO_NOT_FOUND';
  end if;
  if not public.is_restaurant_manager_or_owner(v_video.restaurant_id) then
    raise exception 'HERO_VIDEO_FORBIDDEN';
  end if;
  return v_video;
end;
$$;

-- The lifecycle -------------------------------------------------------------

create or replace function public.begin_restaurant_hero_video_upload(p_restaurant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video_id uuid;
begin
  perform public.hero_video_authorize(p_restaurant_id);

  -- Serialise per restaurant so two tabs cannot both pass the in-flight
  -- check and race the unique index into an error the owner cannot read.
  perform 1 from public.restaurants where id = p_restaurant_id for update;

  if exists (
    select 1 from public.restaurant_hero_videos
    where restaurant_id = p_restaurant_id
      and status in ('uploading', 'pending_review')
  ) then
    raise exception 'HERO_VIDEO_UPLOAD_IN_FLIGHT';
  end if;

  insert into public.restaurant_hero_videos (restaurant_id, created_by)
  values (p_restaurant_id, auth.uid())
  returning id into v_video_id;

  return v_video_id;
end;
$$;

comment on function public.begin_restaurant_hero_video_upload(uuid) is
  'Reserves one hero video upload for a restaurant and returns the id to upload into. One in flight at a time. Owner/manager only.';

create or replace function public.complete_restaurant_hero_video(
  p_video_id uuid,
  p_video_path text,
  p_poster_paths jsonb,
  p_byte_size integer,
  p_mime_type text,
  p_content_sha256 text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.restaurant_hero_videos;
  v_prefix text;
  v_path text;
begin
  v_video := public.hero_video_authorize_video(p_video_id);

  if v_video.status <> 'uploading' then
    raise exception 'HERO_VIDEO_INVALID_STATE';
  end if;

  -- Every file must live under this video's own folder, so a caller cannot
  -- point a restaurant's hero at another restaurant's object.
  v_prefix := v_video.restaurant_id || '/' || v_video.id || '/';

  -- Deliberately the SAME allow-list as menu images, not a copy of it: one
  -- definition of "a plain file name inside this prefix" means the two
  -- cannot drift apart into two different ideas of a safe path.
  if not public.menu_image_path_is_valid(p_video_path, v_prefix) then
    raise exception 'HERO_VIDEO_INVALID_PATH';
  end if;

  if p_poster_paths is null
    or jsonb_typeof(p_poster_paths) <> 'object'
    or p_poster_paths = '{}'::jsonb then
    raise exception 'HERO_VIDEO_INVALID_PATH';
  end if;

  if exists (
    select 1 from jsonb_each(p_poster_paths) where jsonb_typeof(value) <> 'string'
  ) then
    raise exception 'HERO_VIDEO_INVALID_PATH';
  end if;

  for v_path in select value from jsonb_each_text(p_poster_paths) loop
    if not public.menu_image_path_is_valid(v_path, v_prefix) then
      raise exception 'HERO_VIDEO_INVALID_PATH';
    end if;
  end loop;

  update public.restaurant_hero_videos
  set status = 'pending_review',
      video_path = p_video_path,
      poster_paths = p_poster_paths,
      byte_size = p_byte_size,
      mime_type = p_mime_type,
      content_sha256 = p_content_sha256,
      error = null
  where id = p_video_id;
end;
$$;

comment on function public.complete_restaurant_hero_video(uuid, text, jsonb, integer, text, text) is
  'Records a finished hero video upload and moves it to pending_review. Never to active: publishing is a separate, explicit act.';

create or replace function public.fail_restaurant_hero_video(p_video_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.restaurant_hero_videos;
begin
  v_video := public.hero_video_authorize_video(p_video_id);

  if v_video.status not in ('uploading', 'pending_review') then
    raise exception 'HERO_VIDEO_INVALID_STATE';
  end if;

  update public.restaurant_hero_videos
  set status = 'failed',
      error = left(coalesce(p_error, 'The video could not be processed.'), 500)
  where id = p_video_id;
end;
$$;

create or replace function public.publish_restaurant_hero_video(p_video_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.restaurant_hero_videos;
begin
  v_video := public.hero_video_authorize_video(p_video_id);

  if v_video.status <> 'pending_review' then
    raise exception 'HERO_VIDEO_INVALID_STATE';
  end if;
  -- Belt and braces against the constraint above: activating a row without
  -- paths would put a broken player on the menu.
  if v_video.video_path is null or v_video.poster_paths is null then
    raise exception 'HERO_VIDEO_INVALID_STATE';
  end if;

  -- The outgoing video steps down in the same statement that promotes the
  -- new one, so there is never a moment with two active rows, and never a
  -- moment with none.
  update public.restaurant_hero_videos
  set status = 'superseded'
  where restaurant_id = v_video.restaurant_id
    and status = 'active';

  update public.restaurant_hero_videos
  set status = 'active'
  where id = p_video_id;

  update public.restaurants
  set active_hero_video_id = v_video.id,
      hero_video = jsonb_build_object(
        'video', v_video.video_path,
        'poster', v_video.poster_paths
      )
  where id = v_video.restaurant_id;
end;
$$;

comment on function public.publish_restaurant_hero_video(uuid) is
  'The only route to active. Steps down the outgoing video and denormalises the new one onto restaurants in one statement. Owner/manager only.';

create or replace function public.reject_restaurant_hero_video(p_video_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_video public.restaurant_hero_videos;
begin
  v_video := public.hero_video_authorize_video(p_video_id);

  if v_video.status <> 'pending_review' then
    raise exception 'HERO_VIDEO_INVALID_STATE';
  end if;

  update public.restaurant_hero_videos
  set status = 'rejected'
  where id = p_video_id;
end;
$$;

create or replace function public.remove_restaurant_hero_video(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.hero_video_authorize(p_restaurant_id);

  update public.restaurant_hero_videos
  set status = 'removed'
  where restaurant_id = p_restaurant_id
    and status = 'active';

  -- Both columns together, or the pointer-consistency constraint refuses.
  update public.restaurants
  set active_hero_video_id = null,
      hero_video = null
  where id = p_restaurant_id;
end;
$$;

comment on function public.remove_restaurant_hero_video(uuid) is
  'Takes the hero video off the menu. The row and its objects survive for the retention window; only the diner-facing pointer is cleared.';

-- Grants --------------------------------------------------------------------
--
-- Supabase default privileges grant EXECUTE on every new public function to
-- anon, authenticated and service_role. `revoke ... from public` alone does
-- NOT undo that, which is how four payment functions were left callable by
-- anyone holding the anon key (see 20260919090000). Every function here is
-- revoked from public and anon explicitly; the two internal helpers are
-- revoked from authenticated as well, since nothing outside this file
-- should call them.

revoke execute on function public.hero_video_authorize(uuid) from public, anon, authenticated;
revoke execute on function public.hero_video_authorize_video(uuid) from public, anon, authenticated;
revoke execute on function public.restaurants_guard_hero_video_columns() from public, anon, authenticated;
revoke execute on function public.restaurant_hero_videos_track_status_change() from public, anon, authenticated;

revoke execute on function public.begin_restaurant_hero_video_upload(uuid) from public, anon;
revoke execute on function public.complete_restaurant_hero_video(uuid, text, jsonb, integer, text, text) from public, anon;
revoke execute on function public.fail_restaurant_hero_video(uuid, text) from public, anon;
revoke execute on function public.publish_restaurant_hero_video(uuid) from public, anon;
revoke execute on function public.reject_restaurant_hero_video(uuid) from public, anon;
revoke execute on function public.remove_restaurant_hero_video(uuid) from public, anon;
