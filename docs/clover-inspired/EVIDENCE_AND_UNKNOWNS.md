# Evidence and unknowns

## Evidence index

| ID  | Finding                                                                                                                                                                                    | Type                             | Source                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| E1  | Clover keeps the order's `state` apart from `paymentState` (`OPEN, PAID, PARTIALLY_PAID, REFUNDED, PARTIALLY_REFUNDED, CREDITED`) and from print state (`CREATED, PRINTING, FAILED, DONE`) | observed (source)                | `clover-android-sdk` `v3/order/PaymentState.java`, `PrintState.java`, `Order.java`                                            |
| E2  | A REST-created order without `state` is hidden; set `"open"`                                                                                                                               | observed (published doc comment) | `Order.java`, the `state` field's Javadoc                                                                                     |
| E3  | Order totals are integer cents                                                                                                                                                             | observed (doc comment)           | `Order.java`, "Total price of the order in cents"                                                                             |
| E4  | Tables carry position, size, rotation, capacity and section; sections; landmarks; seat-level guests; order↔table link                                                                      | observed (field names)           | `v3/tables2/Table.java`, `Section.java`, `Landmark.java`, `GuestV2.java`, `TableOrder.java`                                   |
| E5  | Split modes `FULL, SPLIT_GUEST, SPLIT_ITEM, SPLIT_CUSTOM`                                                                                                                                  | observed                         | `v3/order/PayType.java`                                                                                                       |
| E6  | Lines carry `printed`, `printGroup`, and per-line refund/exchange                                                                                                                          | observed (field names)           | `v3/order/LineItem.java`                                                                                                      |
| E7  | Tableside "paid" is coverage by a succeeded payment, never an order status                                                                                                                 | observed                         | `supabase/migrations/20260902090000_tab_payments.sql`                                                                         |
| E8  | Tableside tab = one customer session (one phone); splits freeze that session's orders                                                                                                      | observed                         | `20261002090000_split_bill.sql`, `create_tab_split`                                                                           |
| E9  | Staff Settle up already groups unpaid orders by table and records in-person payment                                                                                                        | observed                         | `src/lib/payments/unpaid-orders.ts`, `src/app/dashboard/checkout/page.tsx`                                                    |
| E10 | Tableside `tables` has only number, display name and active                                                                                                                                | observed                         | `20260821130600_tables.sql`, `src/lib/tables/schema.ts`                                                                       |
| E11 | Clover's ToS forbid automated scraping (§2.6(c)) and reverse engineering or derivative works (§13.2)                                                                                       | observed                         | clover.com/terms, REA evidence `ev_e0ea434f94d0f316f3973ace739c7b069d075c4d0abb1330cc4c23a7d25f4ef8` (one headless page load) |

SDK version read: `clover/clover-android-sdk` default branch, shallow clone made 2026-10-14.
Field lists were taken from `CacheKey` getters; behavior beyond the doc comments wasn't
assumed.

## What was not done, on purpose

- No analysis of the clover.com site, the Register app or the dashboard's code beyond reading
  the terms (E11). The three public files fetched before the terms were read (the sitemap,
  its URL list, and the terms page shell) are in `Beacon web/reverse-engineering/clover/captures/`,
  outside this repo.
- No Clover screens viewed. The UI in UI_SPEC.md is original.

## Unknowns

| #   | Question                                                              | Why it matters                                | How to resolve                                                            |
| --- | --------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------- |
| U1  | How Clover rounds tax (its `Calc` class is in a private library)      | F3 totals must match the register to the cent | Compare totals for a few orders in the sandbox                            |
| U2  | Whether Tableside records when an order's status changes              | The accuracy of `since` in F1                 | Check the order status functions and audit columns while building Phase 1 |
| U3  | Whether a private Clover app needs approval before production         | Phase 4 go-live                               | Ask Clover developer relations                                            |
| U4  | Clover webhook signing and retry behavior                             | F3 idempotency                                | Clover developer docs and sandbox tests                                   |
| U5  | Whether split bill (phase J) works with a real Stripe Checkout        | Phase 3 builds on it                          | Run the real-Checkout test (REBUILD_PLAN Phase 3)                         |
| U6  | Do restaurants want diner-started table bills, or staff-started only? | F2 scope                                      | Ask Nashta. Staff-only could ship first.                                  |
