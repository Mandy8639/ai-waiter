-- Drop is_high_protein, added an hour earlier in 20260925090000.
--
-- WHY A SECOND MIGRATION RATHER THAN EDITING THE FIRST. 20260925090000 had
-- already been applied to production when this decision was made. Editing
-- an applied migration is the drift that cost this project real time
-- before: `supabase db push` reports "up to date" because the version is
-- already recorded, the column stays on production forever, and the file
-- claims otherwise. History that says "added, then removed" is true;
-- history that quietly never mentions it is not.
--
-- WHY IT IS BEING DROPPED. halal and kosher are certifications a
-- restaurant genuinely holds and can stand behind. "High in protein" is a
-- quantitative claim with no agreed threshold and no nutrition data behind
-- it — this product has no calorie or macro figures at all (see
-- docs/COMPETITIVE_ROADMAP.md phase M). An owner ticking the box asserts
-- almost nothing, and a diner reading the badge learns almost nothing.
--
-- Better to remove it now, while the column is unused and the feature has
-- not shipped, than after restaurants have ticked it on live menus. At
-- that point removing it means a migration AND explaining to a restaurant
-- why their label disappeared.
--
-- It belongs in phase M, where nutrition data would give it a number to
-- mean something.
--
-- Safe to drop: never merged to main, never exposed in a deployed build,
-- and no row ever set it to true.

alter table public.menu_items
  drop column if exists is_high_protein;
