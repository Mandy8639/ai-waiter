-- How much food this is, in the words a waiter would actually use.
--
-- The obvious design here is `serves integer`, and it is wrong. "Serves 2"
-- is the answer a spreadsheet gives; the question a diner asks is "is this
-- enough for me?" or "can the two of us share it?", and the honest answer
-- to that is not a number:
--
--   "One hungry person will finish it. If you're not that hungry, two can
--    share it with a roti."
--
-- A number cannot carry the "depends how hungry you are" that every real
-- answer to this question contains, and the AI reading a number back would
-- have to either state it flatly (wrong, and unhelpfully confident) or
-- invent the hedging itself (wrong, and unattributable to the restaurant).
-- Storing the sentence lets the restaurant say the true thing once.
--
-- Nullable: most items do not need one. A samosa is a samosa. This is for
-- biryanis, thalis, platters and anything a table might share.

alter table public.menu_items
  add column portion_note text;

-- Two sentences at most. Long enough for "depends how hungry you are",
-- short enough that the AI can read it aloud without it becoming a speech
-- and that it fits on the item page without collapsing.
alter table public.menu_items
  add constraint menu_items_portion_note_length
  check (portion_note is null or char_length(portion_note) <= 200);

comment on column public.menu_items.portion_note is
  'Plain-language answer to "how many people does this feed?", e.g. "Generous for one, or two if you order a roti alongside." Deliberately free text rather than a serves-N integer: the true answer depends on appetite and a number cannot say so. Shown to diners on the item page and read out by the AI waiter. Covered by details_source like the other detail text.';

-- No index and no backfill: read as part of a row the caller already has,
-- and an empty portion note is the correct state for most dishes.
