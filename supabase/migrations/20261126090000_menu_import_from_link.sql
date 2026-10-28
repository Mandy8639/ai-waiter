-- Importing a menu from a link to the restaurant's own menu or ordering
-- page (src/lib/menu-import/link.ts), alongside photos and PDFs. A PDF
-- needs nothing here: the browser turns its pages into photos.
--
-- The link is kept on the import, like source_paths for photos, so an
-- import can be traced to what it read.

alter table public.menu_imports
  add column source_url text;

alter table public.menu_imports
  add constraint menu_imports_source_url_shape
  check (
    source_url is null
    or (char_length(source_url) <= 2000 and source_url ~ '^https?://')
  );

comment on column public.menu_imports.source_url is
  'The web page a menu was read from, for imports from a link. Null for photo and PDF imports.';
