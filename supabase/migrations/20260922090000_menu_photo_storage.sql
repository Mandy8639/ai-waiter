-- Menu photos, phase 2: the two storage areas the phase 1 data model
-- reserved ("Storage object paths (buckets arrive in phase 2)").
--
-- Two buckets, one key structure. Phase 1 already fixes every path as
-- {restaurant_id}/{menu_item_id}/{image_id}/<plain file name> and refuses
-- anything else (menu_image_path_is_valid), so the same key names the
-- original in the private bucket and each variant in the published one.
-- Nothing about the bucket is stored in the database: original_path is
-- always private, variant_paths always published.
--
--   menu-photos-private   {r}/{i}/{img}/original.jpg     the camera file
--   menu-photos           {r}/{i}/{img}/small.webp       diner-facing
--                         {r}/{i}/{img}/medium.webp
--                         {r}/{i}/{img}/large.webp
--
-- WHY THE PRIVATE BUCKET HAS NO POLICIES AT ALL
--
-- The obvious approach is the one the menu-imports bucket already uses:
-- allow an owner or manager to write anywhere under their own restaurant's
-- folder, via
--   is_restaurant_manager_or_owner((storage.foldername(name))[1]::uuid)
-- That is sound tenant isolation, and it is not enough here. It authorizes
-- a restaurant's whole folder, so a manager holding a valid session could
-- write to any dish and any image id under it — including one belonging to
-- an image record they were never granted, or a path with no record behind
-- it at all. The requirement is narrower: authorization to upload for
-- restaurant A / dish X / image Y must not also authorize A / dish Z.
--
-- A policy cannot express that, because the only thing it can see is the
-- object name. So the private bucket grants nothing to anon or
-- authenticated: RLS is on, no policy matches, every ambient read and write
-- is refused. The single way in is a signed upload URL, minted server-side
-- for one exact object path, short-lived, and issued only after
-- begin_menu_item_image_upload() has already proved the caller owns or
-- manages that restaurant and that the dish and image record are really
-- theirs. Authorization is therefore per-object rather than per-tenant, and
-- it cannot be replayed against a different path.
--
-- The published bucket is public for reading (a menu is public) and writable
-- only by service_role: the diner-facing bytes are produced exclusively by
-- the server's own processing step, never uploaded by a client.
--
-- No functions are created here, so there are no EXECUTE grants to classify
-- and nothing for the phase 1 grant tests to pick up.

-- Private area -------------------------------------------------------------
-- Originals as the camera produced them: full resolution, EXIF intact,
-- possibly with GPS. They are never served to diners. Retained so a
-- reprocess is possible and so the 30-day retention window in
-- docs/MENU_PHOTO_STRATEGY.md has something to hold.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'menu-photos-private',
  'menu-photos-private',
  false,
  -- 15 MB: comfortably above a 12 MP phone photo (~4-6 MB) with headroom
  -- for a high-quality export, well below anything that would hurt to
  -- decode. The application refuses larger before it ever asks for a URL;
  -- this is the backstop for a client that skips the application.
  15728640,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- Published area -----------------------------------------------------------
-- Sanitized, resized, re-encoded variants. Immutable: a replacement photo
-- is a new image id and therefore a new path, never an overwrite, so these
-- objects can be cached for a year without an invalidation story.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'menu-photos',
  'menu-photos',
  true,
  -- A processed variant is tens to a few hundred KB; 2 MB is a generous
  -- ceiling that still refuses anything that clearly is not our output.
  2097152,
  array['image/webp']
)
on conflict (id) do nothing;

-- Policies -----------------------------------------------------------------
-- Deliberately none for 'menu-photos-private'. See the header: RLS is
-- enabled on storage.objects, so with no policy matching this bucket every
-- select, insert, update and delete by anon or authenticated is refused,
-- and the only way in is a signed URL minted for one exact path.
--
-- For 'menu-photos', public reads are served by Supabase's public object
-- endpoint without consulting RLS. Writes get no policy either, so only
-- service_role — the server's own processing step — can create, replace or
-- remove a published variant.
--
-- An absence is easy to mistake for an oversight, and easy to erode: one
-- later migration adding a "convenient" policy would silently widen access
-- from a single signed path back to a whole tenant folder. That is guarded
-- in tests/integration/db/menu-photo-storage.test.ts, which asserts on
-- every run that no policy references either bucket and that anon and
-- authenticated can neither read nor write them. A check written here
-- instead would run once, when this migration is applied, and never again.
