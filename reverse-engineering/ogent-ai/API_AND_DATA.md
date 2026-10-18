# Ogent.AI — API and data

## What is actually known

| Category                              | Status                                                             |
| ------------------------------------- | ------------------------------------------------------------------ |
| API requests observed at runtime      | **None.** No page was loaded; no traffic captured.                 |
| Endpoint candidates found in code     | **None.** No bundle or APK was obtained.                           |
| Public URLs observed (search index)   | Listed below. These are web pages, not APIs.                       |
| Request/response shapes, auth, errors | **Unknown.**                                                       |
| Server implementation, database       | **Unknown**, and out of reach of client-side analysis in any case. |

### Observed public URLs (E03 and others)

```
https://ogent.ai/
https://ogent.ai/get-started
https://ogent.ai/lp/free-qr-ordering
https://ogent.ai/ogent-features
https://ogent.ai/faq
https://ogent.ai/site-index
https://ogent.ai/table-service-ordering
https://ogent.ai/counter-service-ordering
https://ogent.ai/bar-qr-code-ordering
https://ogent.ai/integrations
https://ogent.ai/integrations/square-online-ordering-and-qr-code-ordering-integration
https://ogent.ai/integrations/clover-online-ordering-and-qr-code-ordering-integration
https://ogent.ai/clover-online-ordering-and-qr-code-order-integration
https://ogent.ai/integrations/microsale-online-ordering-and-qr-code-ordering-integration
https://ogent.ai/microsale-online-ordering-and-qr-code-order-integration-2
https://ogent.ai/integrations/square-doordash-integration
https://ogent.ai/guides/doordash-merchant-portal-vs-square-dashboard
https://ogent.ai/gloriafood-alternative
https://ogent.ai/gloriafood-shutdown
https://ogent.ai/best-gloriafood-alternatives
https://ogent.ai/compare/ogent-ai-vs-toast
https://ogent.ai/compare/ogent-ai-vs-chowly
https://ogent.ai/compare/ogent-ai-vs-tabski
https://ogent.ai/compare/ogent-ai-vs-olo
https://ogent.ai/compare/ogent-ai-vs-cloudwaitress
https://ogent.ai/compare/ogent-ai-vs-upmenu
https://ogent.ai/ogent-terms-privacy-policy
https://restaurant.ogent.ai/qr-code-menu-best-practices-for-restaurants/
https://migrate-to.ogentai.com/
https://play.google.com/store/apps/details?id=com.ogentai.operator
```

The guest-ordering and dashboard hostnames are **unknown**. No storefront or dashboard URL
appeared in the index.

### Data entities implied by product copy (inferred, not observed schemas)

| Entity              | Attributes implied by copy                                                                     | Evidence |
| ------------------- | ---------------------------------------------------------------------------------------------- | -------- |
| Store / location    | name, location, prep time, hours, holidays & special hours, delivery max miles, pause state    | E02, E07 |
| POS connection      | provider (Square/Clover/MicroSale), sync state                                                 | E09      |
| Payment gateway     | provider (Stripe/Authorize.net/CardConnect/POS), merchant credentials                          | E01      |
| Menu / category     | schedule (time-based visibility)                                                               | E02      |
| Item                | name, description, price, photo, availability, 86-until                                        | E02, E09 |
| Modifier / option   | price, out-of-stock flag                                                                       | E02      |
| Table / QR code     | per-table code; single-counter code                                                            | E06, E07 |
| Order               | source (QR/online/dine-in/delivery), fulfilment type, status, pickup slot, tip, payment method | E02, E07 |
| Order line          | item, modifiers, price; refundable individually                                                | E02      |
| Refund              | full or partial-by-line                                                                        | E02      |
| Customer            | phone, order count, total spend                                                                | E02      |
| Notification        | SMS: confirm / ready / delay                                                                   | E07, E09 |
| Plan / subscription | Pay As You Go 4% or $149/mo                                                                    | E01      |

---

## PROPOSED replacement design

> Everything in this section is **proposed** by this investigation. It is not Ogent's API. It
> is written to slot into Tableside (Next.js + Supabase/Postgres + RLS + Stripe Connect), which
> already has most of the dine-in entities.

### Proposed schema additions (Postgres)

```sql
-- PROPOSED
create type fulfillment_type as enum ('dine_in', 'pickup', 'delivery');
create type order_source as enum ('table_qr', 'counter_qr', 'online', 'doordash', 'ubereats', 'pos');

alter table orders
  add column fulfillment fulfillment_type not null default 'dine_in',
  add column source order_source not null default 'table_qr',
  add column pickup_slot_start timestamptz,           -- null for dine-in
  add column ticket_release_at timestamptz,           -- slot_start - prep_minutes
  add column guest_phone_e164 text,                   -- pickup / delivery only
  add column sms_opt_in boolean not null default false,
  add column delivery_address jsonb,
  add column external_ref text;                       -- POS / marketplace id

create table pickup_slot_rules (
  restaurant_id uuid references restaurants on delete cascade,
  slot_minutes int not null check (slot_minutes in (5,10,15,30)),
  max_orders_per_slot int not null check (max_orders_per_slot > 0),
  min_lead_minutes int not null default 15,
  primary key (restaurant_id)
);

-- weekly hours already exist per menu (public.menu_hours); this adds date overrides
create table special_hours (
  restaurant_id uuid references restaurants on delete cascade,
  day date not null,
  closed boolean not null default false,
  opens time, closes time,
  primary key (restaurant_id, day)
);

alter table menu_items add column unavailable_until timestamptz; -- 86 with auto-restore

create table guest_messages (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders on delete cascade,
  kind text not null check (kind in ('confirmed','ready','delayed','pickup_changed')),
  to_e164 text not null,
  provider_id text,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);

create table operator_commands (       -- audit log for the AI assistant
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid references restaurants,
  actor_user_id uuid,
  channel text check (channel in ('sms','app_chat','dashboard_chat')),
  utterance text not null,
  tool_calls jsonb not null,
  confirmed boolean not null,
  created_at timestamptz default now()
);
```

### Proposed endpoints

| Method | Path                                                        | Auth               | Purpose                                                |
| ------ | ----------------------------------------------------------- | ------------------ | ------------------------------------------------------ |
| GET    | `/api/r/{slug}/pickup-slots?date=`                          | anonymous          | Available slots after capacity and lead time           |
| POST   | `/api/r/{slug}/orders` (existing `submit_order()` extended) | anonymous session  | Adds `fulfillment`, `pickup_slot_start`, `guest_phone` |
| POST   | `/api/orders/{id}/status`                                   | staff              | Existing transition; `ready` enqueues SMS              |
| POST   | `/api/orders/{id}/pickup-time`                              | staff              | Move slot; enqueue `pickup_changed` SMS                |
| POST   | `/api/orders/{id}/delay-notice`                             | staff              | Free-text or templated delay SMS                       |
| POST   | `/api/webhooks/sms/inbound`                                 | provider signature | Operator commands + STOP/HELP handling                 |
| POST   | `/api/assistant/command`                                    | staff              | In-app operator assistant                              |
| POST   | `/api/integrations/{pos}/webhook`                           | provider signature | POS menu and status updates                            |
| POST   | `/api/migrate/gloriafood`                                   | owner              | URL → draft menu for review (never auto-publish)       |

### Proposed rules

- `ticket_release_at = pickup_slot_start − estimated_prep_minutes − busy_extra_minutes`, where
  `estimated_prep_minutes` reuses Tableside's existing preparation-time estimate (see the
  `kitchen_queue_ahead` migrations) and `busy_extra_minutes` is the existing column on
  `restaurant_settings`. The kitchen board hides pickup orders until then.
- Slot capacity check happens inside `submit_order()` in the same transaction, under a row lock
  per (restaurant, slot).
- 86 via the assistant sets `unavailable_until = next opening time` in the restaurant's timezone.
  A scheduled job (or a read-time check `is_available and (unavailable_until is null or
unavailable_until <= now())`) restores the item.
- The assistant's destructive commands (remove item, price change) require an explicit "yes"
  reply. Availability and pause commands apply immediately with an undo hint.
- Inbound SMS commands are accepted only from phone numbers verified on a staff profile with a
  manager or owner role.
