-- Track whether a dish's heat level was set by a person or guessed.
--
-- Deliberately NOT folded into details_source. That column covers the
-- description, preparation time and portion note, which a restaurant
-- reviews together by opening the item and saving it. Heat is reviewed
-- somewhere else and at a different moment: it is a single choice from a
-- fixed ladder, it is the one attribute a diner filters on before they
-- pick a dish, and a menu import produces a suggestion for every item at
-- once. Reusing details_source would mean confirming a dish's heat also
-- silently claims somebody read its description.
--
-- Not gated like allergens either. An unconfirmed allergen is hidden from
-- diners because acting on a wrong one is dangerous; a wrong heat level
-- spoils a meal. So the suggestion is visible immediately and this column
-- exists to show the restaurant what still needs a glance.

alter table public.menu_items
  add column spice_level_source text not null default 'restaurant';

alter table public.menu_items
  add constraint menu_items_spice_level_source_valid
  check (spice_level_source in ('restaurant', 'ai_draft'));

comment on column public.menu_items.spice_level_source is
  'Where spice_level came from. ''ai_draft'' means it was suggested from the dish name during import and nobody has confirmed it; the spice review page lists exactly these. Set to ''restaurant'' when a person confirms or changes it, and by any manual edit of the item.';

-- Existing rows keep the DEFAULT: whatever spice_level they carry was
-- typed in by staff, so it is the restaurant's own statement by
-- definition. (At the time of writing every row is NULL, which is why
-- "something spicy" returned nothing on a menu of 153 dishes.)
--
-- Index: unlike details_source this IS filtered across the table, by the
-- review page asking "what still needs looking at?". Partial, because the
-- confirmed rows are exactly the ones that query never wants.
create index menu_items_spice_review_idx
  on public.menu_items (restaurant_id)
  where spice_level_source = 'ai_draft';
