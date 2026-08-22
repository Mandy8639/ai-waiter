-- The tenant root. Every other restaurant-owned table traces back here via
-- restaurant_id, directly or transitively.
create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  logo_url text,
  cover_image_url text,
  phone text,
  address text,
  city text,
  state text,
  postal_code text,
  country text,
  timezone text not null default 'America/New_York',
  currency text not null default 'USD',
  tax_rate numeric(5, 4) not null default 0,
  service_charge numeric(5, 4) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint restaurants_name_not_blank check (length(trim(name)) > 0),
  -- Lowercase kebab-case: safe for use in URLs without further encoding.
  constraint restaurants_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- ISO 4217-shaped (3 uppercase letters). Not validated against the real
  -- currency list at the DB layer — that's an application/Zod concern.
  constraint restaurants_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- Stored as a fraction (0.0825 = 8.25%), so anything outside 0-1 is a typo.
  constraint restaurants_tax_rate_range check (tax_rate >= 0 and tax_rate <= 1),
  constraint restaurants_service_charge_range check (service_charge >= 0 and service_charge <= 1)
);

comment on table public.restaurants is
  'One row per tenant restaurant. Root of every tenant-scoped table in the schema.';
comment on column public.restaurants.tax_rate is
  'Fraction, e.g. 0.0825 for 8.25%. Not a percentage integer.';

create trigger trg_restaurants_set_updated_at
  before update on public.restaurants
  for each row
  execute function public.set_updated_at();

-- RLS is enabled immediately so there is never a window where this table is
-- readable without a policy. Policies land in 20260821130400_core_rls_policies.sql
-- once the auth helper functions exist (see that file for why the ordering
-- matters) — until then, this table is deny-all to every non-privileged role.
alter table public.restaurants enable row level security;
