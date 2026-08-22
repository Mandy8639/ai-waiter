-- Shared trigger function: keeps `updated_at` current on every UPDATE.
-- Applied per-table below rather than relied on from application code, so it
-- holds even for writes issued outside the app (SQL editor, future services).
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Trigger function: sets NEW.updated_at = now() on UPDATE. Attach as a BEFORE UPDATE trigger on any table with an updated_at column.';
