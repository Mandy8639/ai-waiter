# Ogent.AI — reverse-engineering investigation

> **Read this first.** The live site could not be reached from this investigation environment,
> and the requested REA (`reverse-engineer-anything`) skill and tools were not installed. Every
> finding here comes from **search-engine indexes of Ogent's own public pages** (vendor marketing,
> FAQ, comparison pages, and a Google Play listing). No page was loaded, no JavaScript bundle was
> read, no request was captured, and no screenshot was taken. Treat this as a **product and
> behaviour specification built from public claims**, not as a technical teardown. See
> [EVIDENCE_AND_UNKNOWNS.md](EVIDENCE_AND_UNKNOWNS.md) for exactly what was blocked and what is
> needed to finish.

## Target identity

| Item                 | Value                                                                                                                               | Class                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Product              | Ogent AI ("Ogent.AI"), QR-code & online ordering for restaurants with an AI assistant for operators                                 | Observed (indexed copy) — E01, E02                    |
| Company              | Ogent AI LLC, Foster City, CA; founder & CEO listed as Anup Balagopal; claims "300+ restaurant partners"                            | Observed (vendor self-description) — E15              |
| Marketing site       | `https://ogent.ai` (≈46 pages in 9 sections per its `/site-index`)                                                                  | Observed (indexed) — E03                              |
| Blog                 | `https://restaurant.ogent.ai/…` (WordPress-style permalinks)                                                                        | Observed URL; platform inferred — E05                 |
| Menu-migration tool  | `https://migrate-to.ogentai.com/` (note different apex domain `ogentai.com`)                                                        | Observed URL in FAQ — E11                             |
| Merchant mobile app  | "Ogent.ai: Restaurant Operator", Android package `com.ogentai.operator`; also claimed on Apple App Store                            | Observed (Play listing in index) — E13, E14           |
| Guest ordering app   | Browser-based (no download, no account)                                                                                             | Observed (claim) — E06                                |
| App version          | Unknown                                                                                                                             | Unknown                                               |
| Source code          | Not available (third-party, closed)                                                                                                 | —                                                     |
| Relationship to repo | **None.** This repo is _Tableside_, a separate AI-waiter product. Ogent is a competitor; the repo is only where findings are saved. | Observed (`README.md`, no `ogent` string in the repo) |

## Investigation scope

- **In scope (attempted):** public marketing site, product pages, FAQ, integrations pages,
  comparison pages, migration tool, merchant app store listing.
- **Not attempted, by design:** signing up, creating a store, placing orders, payments, contacting
  sales, or anything that writes to Ogent's production systems.
- **Blocked:** see the table below.

| Route                                             | Result                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| REA skill / MCP tools (`binary_session`, etc.)    | Not installed in this session; no matching tool or skill on disk             |
| `curl` / Playwright Chromium → `ogent.ai`         | Egress proxy `403 connect_rejected` (host not on the environment allow-list) |
| Same for `ogentai.com`, `restaurant.ogent.ai`     | `403 connect_rejected`                                                       |
| Same for `web.archive.org`, `play.google.com`     | `403 connect_rejected`                                                       |
| WebFetch tool → any of the above                  | `getaddrinfo ENOTFOUND` (the fetch backend's DNS failed for every host)      |
| WebSearch tool, restricted to `ogent.ai` and open | **Worked** — 22 queries, the only evidence channel                           |

## Findings summary

Ogent is a **POS-attached ordering layer** for independent restaurants, bars, breweries, food
trucks and food halls. It is _not_ a guest-facing AI waiter. The "AI" is an **operator assistant**
that changes store state from plain-English text messages ("86 the salmon", "pause ordering for an
hour").

1. **Three guest channels on one menu:** table-service QR (order, reorder rounds, pay at table),
   counter-service QR / order-ahead pickup with time slots, and a branded online storefront with
   pickup and delivery (radius in driving miles).
2. **POS-first architecture:** it imports the menu from Square, Clover or MicroSale (items,
   modifiers, prices, photos) and pushes orders back into the POS / KDS / kitchen printers so
   "staff sees no change". Orders from DoorDash and Uber Eats land in the same dashboard.
3. **No payment processor of its own:** card data passes through to the merchant's processor
   (Stripe, Authorize.net, CardConnect, or the POS's own). Apple Pay and Google Pay are offered.
4. **Order lifecycle:** New → In-Progress → Order-Ready → Completed, with an SMS to the guest at
   "Ready", plus delay texts and a "Change Pickup Time" action.
5. **Operator tools:** web dashboard (menu, hours, holidays, scheduling of items/categories,
   delivery zone, refunds, analytics) and a free merchant app (live order feed, audio and push
   alerts, auto-print, revenue snapshot, biometric login).
6. **AI assistant:** text commands for 86-ing items (auto-restore next day), out-of-stock
   modifiers, pausing ordering (30 min / 1 h / 2 h / until tomorrow), and price edits. Parts are
   marked "Coming Soon" on the homepage, so **live availability is unconfirmed**.
7. **Pricing (inconsistent across pages):** "Pay As You Go" at 4% of net sales with no monthly fee
   (one page mentions a $29 activation fee; others say 0% / free), and "POS Integration" at a flat
   $149/month with no contract. An "AI Assisted Ordering" tier is "coming soon".
8. **Growth wedge:** heavy SEO around GloriaFood's announced shutdown (April 30, 2027), with an
   AI menu-migration tool that rebuilds a GloriaFood menu from its public ordering link.

## Coverage matrix

| Feature / subsystem                        | Status                   | Notes                                                                    |
| ------------------------------------------ | ------------------------ | ------------------------------------------------------------------------ |
| Product positioning & segments             | Analyzed (secondary)     | Consistent across many pages                                             |
| Pricing & plans                            | Partially analyzed       | Pages contradict each other; no live pricing page read                   |
| Table-service QR ordering                  | Partially analyzed       | Flow known from copy; UI not seen; tab/split-check model unknown         |
| Counter / order-ahead / pickup             | Partially analyzed       | Status machine and SMS events described; slot rules unknown              |
| Online storefront & delivery               | Partially analyzed       | Radius rule known; fees, minimums and dispatch unknown                   |
| Guest checkout & payments                  | Partially analyzed       | Gateways named; tokenisation flow and fee split unknown                  |
| Tips                                       | Partially analyzed       | On-screen prompts; defaults not published                                |
| Refunds                                    | Partially analyzed       | Full or itemised partial, from Order Details                             |
| Order management / statuses                | Partially analyzed       | Four statuses named                                                      |
| Guest SMS notifications                    | Partially analyzed       | Events known; provider unknown                                           |
| Operator AI assistant (SMS/chat commands)  | Partially analyzed       | Command examples only; grammar, channel and auth unknown                 |
| Menu management, scheduling, hours         | Partially analyzed       | Feature names only                                                       |
| Analytics                                  | Partially analyzed       | Metric list known                                                        |
| Merchant mobile app                        | Partially analyzed       | Play listing summary only; binary not obtained                           |
| POS integrations (Square/Clover/MicroSale) | Partially analyzed       | Direction of sync known at a high level; 86/inventory write-back unknown |
| Delivery-platform integrations             | Partially analyzed       | DoorDash, Uber Eats; Grubhub "coming soon"                               |
| GloriaFood migration tool                  | Partially analyzed       | Inputs/outputs known; implementation unknown                             |
| Partner / reseller program                 | Blocked                  | Linked but terms not indexed                                             |
| Authentication & roles (merchant)          | Blocked                  | Only "biometric login" in app; roles unknown                             |
| Client architecture, bundles, APIs         | **Blocked**              | Needs live site access or the APK                                        |
| Backend, database, infrastructure          | Not applicable / unknown | Private server; out of reach of client-side analysis anyway              |
| Visual design, layout, accessibility       | **Blocked**              | No page rendered; no screenshots                                         |
| Multi-language                             | Unknown                  | No mention found (absence not proven)                                    |

## Deliverables

- [FEATURES.md](FEATURES.md) — feature inventory, user journeys, business rules, verification scenarios
- [ARCHITECTURE.md](ARCHITECTURE.md) — inferred components, boundaries, data flow, Mermaid diagrams
- [API_AND_DATA.md](API_AND_DATA.md) — what is known about contracts and data, and a clearly labelled proposed model
- [UI_SPEC.md](UI_SPEC.md) — screen inventory from copy; visual spec blocked
- [REBUILD_PLAN.md](REBUILD_PLAN.md) — phases and acceptance criteria, mapped onto Tableside's existing code
- [EVIDENCE_AND_UNKNOWNS.md](EVIDENCE_AND_UNKNOWNS.md) — evidence index, blockers, next investigations

## Recommendation

Rebuild **counter-service / order-ahead pickup with SMS "ready" notifications** first (see
[REBUILD_PLAN.md](REBUILD_PLAN.md#phase-1--order-ahead-pickup-and-guest-sms)). It is the clearest,
best-specified Ogent flow. It is also the biggest capability gap in Tableside, which today is
dine-in only, and it reuses Tableside's existing order state machine, `submit_order()`, kitchen
board and Stripe checkout almost unchanged.
