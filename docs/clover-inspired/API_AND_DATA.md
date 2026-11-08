# API and data

**Everything in this file is proposed.** Names follow existing conventions: text and CHECK
instead of enums, composite tenant-scoped foreign keys, and SECURITY DEFINER functions doing
their own membership check, with `anon` EXECUTE revoked explicitly (see
`20261017090000_revoke_anon_from_signed_in_functions.sql`).

## F1 schema

```sql
create table public.floor_sections (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 40),
  sort_order integer not null default 0,
  grid_cols integer not null default 24 check (grid_cols between 8 and 64),
  grid_rows integer not null default 16 check (grid_rows between 8 and 64),
  constraint floor_sections_restaurant_id_id_key unique (restaurant_id, id)
);

alter table public.tables
  add column section_id uuid,                -- null = in the tray (not placed)
  add column pos_x integer, add column pos_y integer,
  add column width integer, add column height integer,
  add column rotation smallint not null default 0 check (rotation in (0, 90, 180, 270)),
  add column shape text not null default 'square' check (shape in ('square', 'round', 'rect')),
  add column seats smallint check (seats between 1 and 30),
  add constraint tables_section_same_restaurant
    foreign key (restaurant_id, section_id)
    references public.floor_sections (restaurant_id, id) on delete set null (section_id),
  -- placed means all four numbers, never some of them
  add constraint tables_placement_complete check (
    (section_id is null) or
    (pos_x is not null and pos_y is not null and width > 0 and height > 0)
  );

create table public.floor_landmarks (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null,
  section_id uuid not null,
  label text check (label is null or char_length(label) <= 30),
  kind text not null check (kind in ('bar', 'wall', 'door', 'kitchen', 'other')),
  pos_x integer not null, pos_y integer not null,
  width integer not null check (width > 0), height integer not null check (height > 0),
  foreign key (restaurant_id, section_id)
    references public.floor_sections (restaurant_id, id) on delete cascade
);
```

Overlap between tables in a section is checked in `save_floor_layout()` (below), not by a
constraint. Rectangles with rotation are awkward to express as an exclusion constraint, and the
layout is saved all at once anyway.

RLS: members select; owners and managers write, through the function only.

## F1 functions

| Function                                                                                                                               | Who           | Does                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `save_floor_layout(p_section_id, p_tables jsonb, p_landmarks jsonb)`                                                                   | owner/manager | Replaces one section's placements atomically. Rejects overlaps, off-grid positions and tables from another restaurant. |
| `table_live_state(p_restaurant_id)` → `setof (table_id, state, since, unpaid_total, currency, ready_count, open_request_kinds text[])` | member        | Read-only. Applies the rule order in FEATURES.md. `STABLE`, `security definer`, membership check first.                |

`since` is the timestamp of the event that put the table in its current state (request
`created_at`, order status change, payment `succeeded_at`, or session `started_at`). Where
Tableside doesn't record the time of a status change, `since` falls back to `orders.updated_at`
and the UI labels it "about". **To confirm while building:** whether order status changes are
timestamped (see EVIDENCE_AND_UNKNOWNS.md).

## F2 schema

```sql
alter table public.tab_splits
  add column scope text not null default 'session' check (scope in ('session', 'table')),
  add column table_id uuid,
  add column created_by_staff uuid references auth.users (id) on delete set null,
  add constraint tab_splits_table_scope_has_table check ((scope = 'table') = (table_id is not null)),
  add constraint tab_splits_table_same_restaurant
    foreign key (restaurant_id, table_id) references public.tables (restaurant_id, id);

-- one open table bill per table
create unique index tab_splits_one_open_table_bill
  on public.tab_splits (table_id) where status = 'open' and scope = 'table';
```

`customer_session_id` stays the creator for diner-started bills. For staff-started bills it
needs to become nullable. That check moves into a CHECK on `scope` and
`created_by_staff`. This is the one change to an existing constraint, and it needs its own test.

## F2 functions

| Function                                                         | Who                 | Does                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preview_table_bill()`                                           | diner (own session) | Returns the table's unpayable/payable lines grouped by `guest_label`. No IDs. Read-only.                                                                     |
| `create_table_bill(p_mode text, p_share_count int default null)` | diner (own session) | Like `create_tab_split`, but freezes the unpaid orders of **every active session at the caller's table**. Modes: `'all'` (one unit), `'equal'`, `'by_dish'`. |
| `create_table_bill_for_table(p_table_id, p_mode, p_share_count)` | member              | Same, started by staff. Returns the share link token.                                                                                                        |
| `cancel_table_bill(p_split_id)`                                  | creator or member   | Only while no unit is `pending` or `paid`.                                                                                                                   |

Errors reuse the existing codes where the meaning matches (`PAYMENT_IN_PROGRESS`,
`PAYMENT_NOTHING_TO_PAY`, `PAYMENT_MIXED_CURRENCY`, `SPLIT_TOO_SMALL`) and add
`SPLIT_ALREADY_OPEN_AT_TABLE` and `TABLE_BILL_BLOCKED_BY_SPLIT`.

## F3 data

| Tableside                                         | Clover (from the published SDK model)       | Note                                                              |
| ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| `orders.id`                                       | `Order.externalReferenceId`                 | Used to match both ways                                           |
| new `orders.external_id`                          | `Order.id`                                  | Written after the create call succeeds                            |
| —                                                 | `Order.state = "open"`                      | **Required** on REST create, or the order is hidden               |
| `orders.total` (numeric)                          | `Order.total` (cents, integer)              | Convert with the `to_minor_units` rule                            |
| `order_items.item_name`, `unit_price`, `quantity` | `LineItem.name`, `price` (cents), `unitQty` | Lines are immutable once written, so a retry sends the same thing |
| `order_items.notes`                               | `LineItem.note`                             |                                                                   |
| `menu_items.external_id`                          | `LineItem.item.id`                          | When the menu is matched. Otherwise a custom line item.           |
| `order_payments` (`card_terminal`)                | `Payment` with `paymentState PAID`          | Inbound. Idempotent on the Clover payment ID.                     |

Clover REST paths and webhook signing are taken from Clover's developer docs at build time and
aren't restated here. Check them against the live sandbox before relying on them.
