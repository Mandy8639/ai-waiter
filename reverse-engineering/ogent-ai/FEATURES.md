# Ogent.AI — features, journeys, business rules

Classification key: **O** = observed in Ogent's own indexed page copy (secondary evidence, vendor
claim, not exercised); **I** = inferred by this investigation; **U** = unknown. Evidence IDs (Exx)
are defined in [EVIDENCE_AND_UNKNOWNS.md](EVIDENCE_AND_UNKNOWNS.md). Nothing in this file was
observed at runtime.

## Roles

| Role                          | Evidence                                                         | Class                  |
| ----------------------------- | ---------------------------------------------------------------- | ---------------------- |
| Guest (anonymous, no account) | "no App Store, no download, no account creation" — E04, E06      | O                      |
| Owner / manager / staff       | Play listing: "for restaurant owners, managers, and staff" — E13 | O                      |
| Per-role permissions          | Not described anywhere                                           | U                      |
| Reseller / agency partner     | Partner Program linked from footer; terms not indexed — E03, E11 | O (exists) / U (rules) |

Untested roles: all of them. No account was created.

---

## F01 — Table-service QR ordering

- **Purpose:** dine-in guests order, reorder and pay from their phone without flagging staff.
  **Entry:** scan a per-table QR code or table tent. (O — E06, E08)
- **Inputs / prerequisites:** a phone browser, a published menu, a table-specific code.
- **Sequence (O, E06/E08/E09):**
  1. Scan the table code → menu opens in the browser.
  2. Build the order (items + modifiers) → check out with Apple Pay / Google Pay or a card.
  3. The ticket routes to the kitchen printer, KDS or POS.
  4. **Reorder:** "the last round is saved", so the guest reorders it in one tap (bar page).
  5. Repeat orders during the meal; MicroSale/Clover pages say guests **pay as each order is
     placed** and "can place multiple orders" with a saved card.
- **Business rules:**
  - Pay-per-order (each round is charged when placed), not a single open tab. (I — E09 wording;
    an open-tab mode is **U**.)
  - Tip prompt on every round's checkout. (O — E08)
  - Staff can pause table-side ordering, or 86 an item mid-service by text. (O — E06)
- **States:** loading / empty-menu / error / paused UI not seen (U).
- **Split check:** **U.** Only an Ogent blog post _recommends_ split bills (E05). No feature page
  confirms it.

## F02 — Counter-service / order-ahead pickup

- **Purpose:** food trucks, cafés, food halls and brewery counters take orders without a line.
  **Entry:** one QR code for a single-counter venue, or the online storefront. (O — E07)
- **Sequence (O, E07):**
  1. Guest scans the code → menu → chooses a **pickup slot** → pays.
  2. The kitchen receives the ticket **timed to the slot** ("at the right moment rather than in a
     noon rush").
  3. Staff advance the order **New → In-Progress → Order-Ready → Completed** from Order Details,
     or in the POS.
  4. At **Order-Ready**, the guest gets an automated SMS. No names are called out.
  5. **Exceptions:** staff can send a delay text, and **Change Pickup Time** after placement.
- **Business rules:**
  - Ready SMS fires when the order is flagged ready in _either_ the POS or the Ogent dashboard
    (O). This implies the POS order status is read back into Ogent (I).
  - Slot granularity, capacity per slot, lead time and cut-off: **U**.
- **Setup:** "most counter-service operators are live in under 15 minutes". The menu can be
  uploaded when there is no POS. (O — E07)

## F03 — Online ordering storefront (pickup + delivery)

- **Purpose:** a branded web ordering portal. (O — E02, E10)
- **Rules (O, E02):**
  - Delivery zone = **maximum driving distance in miles**.
  - Delivery is fulfilled by your own staff or by DoorDash / Uber Eats.
  - "Holidays & Special Hours" set custom open or closed dates. Menu items and categories can be
    **scheduled** (shown at certain times).
- **U:** delivery fees, order minimums, ETA logic, how a delivery partner is dispatched (Drive
  API vs. marketplace), and whether guests can schedule an order for a future day.

## F04 — Checkout, payments, tips

- **Gateways (O — E01, E09, E17):** Stripe, Authorize.net, CardConnect, plus Square or Clover
  merchant processing when attached to those POSs. Apple Pay / Google Pay are offered (Clover
  page explicitly).
- **Data handling (O — E16 terms):** "Ogent does not collect or store a Consumer's credit card
  information, but merely serves as conduit…to the credit card processor used by the Merchant."
  So: merchant-owned processor accounts, and client-side tokenisation by the gateway (I).
- **Ogent has no processor of its own;** payouts follow the merchant's processor. (O — E17)
- **Tips:** on-screen prompt that "defaults to higher percentages than guests choose at a card
  reader", routed into the POS the same way card tips are. Exact defaults are **U**. (O — E04)
- **Platform fee (Pay As You Go):** 4% of net sales "processed through the platform". How it is
  collected (application fee on the charge vs. a monthly invoice) is **U**. If Stripe, an
  application fee on a connected account is the likely mechanism (I).

## F05 — Order management (web dashboard + merchant app)

- **Live order feed** across QR, online, dine-in and delivery sources. (O — E02, E13)
- **Order Details actions:** advance status, Change Pickup Time, send delay text, **Issue
  Refund** (full, or partial by item, without going to the processor). (O — E02, E07)
- **Alerts:** push notification plus audio alert on each new order; auto-print to kitchen-station
  and receipt printers; KDS supported. (O — E09, E13)
- **Store settings in the app:** prep time, location. (O — E02)

## F06 — Guest SMS notifications

- Events: order confirmation → ready-for-pickup; ad-hoc delay message. (O — E07, E09)
- The guest phone number is presumably collected at checkout (I). Consent wording, opt-out
  (STOP) handling and provider: **U**.

## F07 — Operator AI assistant ("plain-English commands")

- **Purpose:** change store state without opening the dashboard. (O — E01, E02, E06, E10)
- **Channel:** "by text" / "texting the AI Assistant", plus a chat in the merchant app ("an
  assistant for questions about app features" — E13). The exact channel (SMS number vs. in-app
  chat) is **I/U**.
- **Documented commands (O):**

  | Intent                  | Example phrasing (from copy)                | Effect                                       |
  | ----------------------- | ------------------------------------------- | -------------------------------------------- |
  | 86 an item              | "86 the …" mid-service                      | Item hidden; **auto-reappears the next day** |
  | Hide a dish for the day | "hide … for today"                          | Same as above                                |
  | Modifier out of stock   | mark a modifier option out of stock         | Option unavailable                           |
  | Pause ordering          | "pause ordering for 1 hour"                 | Choices: 30 min / 1 h / 2 h / until tomorrow |
  | Update price            | "update prices"                             | Price change                                 |
  | Remove an item          | FAQ: "type a command to remove a menu item" | Updates right away                           |

- One comparison page lists "86 items **with countdown timer**". (O — E12) This suggests a timed
  86 with a visible remaining time (I).
- **Availability conflict:** the homepage lists "AI Chat for Menu Management" under **Coming
  Soon**, while other pages describe it as available. (O — E01 vs. E02/E06)
- **AI Assisted Ordering plan (coming soon):** "AI-powered management of" the DoorDash and Uber
  Eats channels. Also "AI guest upsell recommendations" on a comparison page. (O — E04, E12)
- **U:** confirmation step before destructive commands, who is authorised to text in (phone
  allow-list?), the undo path, and the model or provider used.

## F08 — Menu management

- Import from Square / Clover / MicroSale: categories, items, modifiers, prices, photos. Clover
  page claims **live price sync**. (O — E09)
- Build or upload a menu manually when there is no POS. (O — E07)
- Schedule items and categories; 86 with next-day auto-restore; modifier stock. (O — E02)
- Merchant app menu editing: **conflict.** The Play listing says add/edit/delete/hide items,
  upload photos and drag-to-reorder (E13); the features page says "on the roadmap" (E02). The
  Play listing is probably newer (I).

## F09 — Analytics

- Total orders, net revenue, average tip, average order size, daily revenue chart. (O — E02)
- Breakdowns by payment method, fulfilment type and order source. (O — E02)
- **Top Items Sold** report; **Customers (Top Spend)** table with order count and total spend
  per customer. (O — E02) This implies guests are identified across orders, probably by phone
  number (I).
- Merchant app: today's revenue, top items, average tip. (O — E02)

## F10 — POS & delivery integrations

| Integration | Claimed capability                                                                                                                                    | Evidence |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Square      | One-click menu import; order routing to Square KDS; inventory sync (direction U); in Square App Marketplace                                           | E09      |
| Clover      | Full menu import incl. photos; live price sync; auto-print; sales & tips reconciliation; Clover payments incl. Apple/Google Pay; in Clover App Market | E09      |
| MicroSale   | Native; auto menu import; pay-per-order                                                                                                               | E09      |
| DoorDash    | Orders into the same dashboard; a Square + DoorDash page explains payouts                                                                             | E09, E17 |
| Uber Eats   | Orders into the same dashboard                                                                                                                        | E09      |
| Grubhub     | "coming soon"                                                                                                                                         | E04      |
| "Any POS"   | Some pages claim it; the native list is the three above                                                                                               | E01      |

- Ogent orders "look identical to regular POS orders". (O — E09)
- **U:** whether 86 / stock changes write back to the POS, and the conflict resolution when both
  sides edit.

## F11 — GloriaFood migration

- **Entry:** `/gloriafood-alternative` → "paste your ordering link" → "Our AI reads your live
  GloriaFood menu and rebuilds it on a real Ogent storefront while you watch". The FAQ points to
  `migrate-to.ogentai.com`. (O — E11)
- **Transfers:** items, categories, photos, descriptions, modifiers. **Not transferred:**
  customer accounts, order history. Ogent tells users to export those from GloriaFood admin
  first. (O — E11)
- **Rule:** existing GloriaFood links and QR codes keep working until swapped; GloriaFood ends on
  April 30, 2027 (Ogent's claim, not independently verified). (O — E11)
- Implementation is likely a scraper of the public GloriaFood ordering widget plus an LLM
  normaliser into Ogent's menu schema (I).

## F12 — Onboarding & plans

- `/get-started` and `/lp/free-qr-ordering` are the self-serve entry points. (O — E10)
- Live in "about 15 minutes" (homepage) vs. "under 30 minutes" (FAQ, Clover page). (O — E01, E04)
- Plans (O — E01, E04, E10, E11; **contradictory**):

  | Plan                     | Price                                                                                   | Includes                                |
  | ------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------- |
  | Pay As You Go            | 4% of net sales, $0/month (one page: $29 activation; another: "0% commission… nothing") | QR + online ordering, merchant app, SMS |
  | POS Integration          | $149/month, no contract, own payment account                                            | Full POS sync (Square/Clover/MicroSale) |
  | AI Assisted Ordering     | "coming soon" (one page shows $299.99)                                                  | AI management of delivery channels      |
  | (stray tier on one page) | $99.99–$149.99/month                                                                    | U                                       |

- Merchant app: free, unlimited devices, no per-seat fees. (O — E02, E04)

## F13 — Marketing / SEO surface (context, not product)

- Comparison pages: vs Toast, Chowly, Tabski, Olo, CloudWaitress, UpMenu; "8 Best GloriaFood
  Alternatives"; GloriaFood shutdown explainer; DoorDash/Square guides. (O — E03, E12, E17)
- This is a reconstruction concern only if the goal includes go-to-market. It is not product
  behaviour.

---

## Verification scenarios

None of these could be run. "Actual" records what the evidence says, not an observation. Use test
stores only; never place real orders on a production merchant.

| ID  | Scenario             | Input                                              | Expected (per Ogent copy)                                       | Actual            | Gap                                         |
| --- | -------------------- | -------------------------------------------------- | --------------------------------------------------------------- | ----------------- | ------------------------------------------- |
| V01 | Table QR order       | Scan table 4 code, add 2 items, pay with test card | Ticket prints / appears on KDS tagged table 4; tip prompt shown | Not run (blocked) | UI, tip defaults, ticket format             |
| V02 | Reorder round        | After V01, tap "reorder last round"                | Identical order created and charged in one tap                  | Not run           | Whether modifiers and notes carry over      |
| V03 | Pickup slot          | Counter QR, choose 12:30 slot                      | Kitchen ticket released relative to 12:30, not at submit        | Not run           | Release lead time, slot capacity            |
| V04 | Ready SMS            | Mark V03 order Order-Ready                         | Guest receives SMS                                              | Not run           | Message text, sender, opt-out               |
| V05 | Change pickup time   | Order Details → Change Pickup Time +15 min         | Guest notified; ticket timing updated                           | Not run           | Whether the guest is notified automatically |
| V06 | AI 86                | Text "86 the salmon"                               | Salmon hidden now, visible again tomorrow                       | Not run           | Confirmation, "tomorrow" boundary/timezone  |
| V07 | AI pause             | Text "pause ordering for 1 hour"                   | New orders refused for 60 min, then auto-resume                 | Not run           | Guest-facing paused message                 |
| V08 | Partial refund       | Refund one item of a 3-item order                  | Processor refund for that line (+ tax?)                         | Not run           | Tax/tip proration rule                      |
| V09 | Delivery radius      | Address 6 driving miles away, limit 5              | Delivery refused, pickup offered                                | Not run           | Error copy, geocoder                        |
| V10 | Square import        | Connect Square sandbox                             | Categories, items, modifiers, prices, photos appear             | Not run           | Re-sync cadence, conflict handling          |
| V11 | GloriaFood migration | Paste a public GloriaFood ordering URL             | Storefront with matching menu                                   | Not run           | Accuracy, review step                       |
| V12 | Pause from dashboard | Pause "until tomorrow"                             | Resumes at next opening time                                    | Not run           | Definition of "tomorrow"                    |
