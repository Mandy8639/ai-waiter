-- Dietary claims a restaurant makes about a dish (phase B)
--
-- Three flags extending the seven menu_items already carries
-- (is_vegetarian, is_vegan, is_spicy, spice_level, contains_nuts,
-- contains_dairy, contains_gluten).
--
-- WHAT FALSE MEANS, AND WHAT IT DOES NOT.
--
-- Every one of these is `not null default false`, matching the existing
-- columns. That makes `false` the value for two very different real-world
-- states, and the distinction is the whole of this migration:
--
--     false  =  "the restaurant has not stated this"
--     false  ≠  "the restaurant states this is NOT so"
--
-- For is_vegetarian that ambiguity is harmless — nobody reads an absent
-- vegetarian label as "confirmed to contain meat". For is_halal it is not
-- harmless at all. A diner who keeps halal, told "no, that isn't halal"
-- about a dish nobody ever assessed, has been given a fact the restaurant
-- never asserted. Told instead "the menu doesn't say — please check with
-- staff", they can act on it.
--
-- So nothing in this system may ever render or report these as a negative.
-- The application reports only the claims that are TRUE (see
-- src/lib/menu/diet-filters.ts, assertedClaims) and the AI tools return an
-- array of asserted claims rather than a set of booleans, precisely so
-- there is no `false` for a model to read as a denial.
--
-- This mirrors the rule already written into diet-filters.ts about why
-- there is no "nut-free" filter: an absent allergen means the restaurant
-- has not said, not that the dish is safe.
--
-- OWNER-ASSERTED, NEVER INFERRED. halal and kosher are religious
-- certifications, not properties derivable from an ingredient list. A dish
-- with no pork and no alcohol is not thereby halal — that depends on
-- sourcing, slaughter and handling, which only the restaurant knows.
-- Nothing in this codebase may set these from ingredients, from a dish
-- name, or from a model's opinion. They are set by an owner or manager in
-- the menu form and by nothing else.

alter table public.menu_items
  add column is_halal boolean not null default false,
  add column is_kosher boolean not null default false,
  add column is_high_protein boolean not null default false;

comment on column public.menu_items.is_halal is
  'TRUE when the restaurant states this dish is halal. FALSE means the restaurant has not stated it — never that the dish is not halal. Owner-asserted only; never inferred from ingredients.';

comment on column public.menu_items.is_kosher is
  'TRUE when the restaurant states this dish is kosher. FALSE means the restaurant has not stated it — never that the dish is not kosher. Owner-asserted only; never inferred from ingredients.';

comment on column public.menu_items.is_high_protein is
  'TRUE when the restaurant states this dish is high in protein. A claim with no agreed threshold and no nutrition data behind it — see docs/COMPETITIVE_ROADMAP.md phase M. Weaker than the other two and labelled as the restaurant''s own description, not a measurement.';

-- No RLS change. These are ordinary menu_items columns and inherit the
-- table's existing policies: public SELECT for a publicly active
-- restaurant, owner/manager UPDATE. No new function, no new grant.
