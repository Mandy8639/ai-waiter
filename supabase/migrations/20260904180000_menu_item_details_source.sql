-- Mark which menu-item detail text came from the AI and has not been read
-- by a person yet.
--
-- Descriptions and preparation times are written DIRECTLY, not held in
-- staging like allergens. That asymmetry is deliberate: an allergen a
-- diner acts on can hurt them, while "fresh mango blended with yogurt and
-- a touch of cardamom" is wrong at worst in the way a menu can be wrong.
-- Gating prose behind per-dish confirmation would cost a restaurant more
-- attention than the risk justifies.
--
-- But it is still the restaurant's voice, published to their customers,
-- and derived from nothing but the dish's NAME. If Nashta's lassi has no
-- cardamom, their menu now tells customers something untrue about their
-- own food. So the restaurant needs to be able to see, at a glance, which
-- text nobody has vouched for — without any of it being blocked.

alter table public.menu_items
  add column details_source text not null default 'restaurant';

alter table public.menu_items
  add constraint menu_items_details_source_valid
  check (details_source in ('restaurant', 'ai_draft'));

comment on column public.menu_items.details_source is
  'Where this item''s description/preparation_time came from. ''ai_draft'' means generated from the dish name and not yet reviewed by anyone; the dashboard flags these. Diners see the text either way — it is a review prompt for staff, not a visibility gate. Reset to ''restaurant'' whenever a person edits the item.';

-- Existing rows were typed in by staff, so they are the restaurant's own
-- words by definition. The DEFAULT covers them; this is only stated so a
-- reader does not have to infer it.
--
-- No index: this is read as part of a row a dashboard page already has,
-- never filtered across the table.
