# Ogent.AI — UI specification

## Status: visual capture blocked

No Ogent page was rendered in this investigation. Proxy and DNS failures are listed in
[EVIDENCE_AND_UNKNOWNS.md](EVIDENCE_AND_UNKNOWNS.md#blockers). As a result there are **no
screenshots** and **no observations** of layout, typography, colour, spacing, component styling,
responsive behaviour or accessibility. Nothing in this file should be taken as a description of
how Ogent _looks_. It is a **screen inventory reconstructed from the product's own copy**, plus
what a rebuild has to show on each screen.

| Visual property | Status                                                   |
| --------------- | -------------------------------------------------------- |
| Layout & grid   | Unknown                                                  |
| Typography      | Unknown                                                  |
| Colour palette  | Unknown                                                  |
| Spacing         | Unknown                                                  |
| Iconography     | Unknown                                                  |
| Responsive      | Guest app is phone-first (stated: ordering from a phone) |
| Accessibility   | Unknown                                                  |
| Dark mode       | Unknown                                                  |

## Screen inventory (from copy)

### Guest web app (C3)

| Screen             | Must show (per copy)                                                                                     | Evidence | Unseen states                    |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------- | -------------------------------- |
| Menu               | Categories, items, photos, descriptions, prices; scheduled items only in their window; 86'd items hidden | E02, E09 | Loading, empty, paused, closed   |
| Item detail        | Modifiers with out-of-stock options disabled                                                             | E02      | Validation on required modifiers |
| Cart / checkout    | Tip prompt (default percentages "higher than at a card reader"); Apple Pay / Google Pay; card            | E04, E08 | Payment declined, network error  |
| Pickup slot picker | Selectable time slots                                                                                    | E07      | Slot full, no slots today        |
| Delivery address   | Address entry; rejected outside the driving-mile radius                                                  | E02      | Error copy                       |
| Confirmation       | Order placed; SMS will follow (pickup)                                                                   | E07, E09 | —                                |
| Reorder            | "Reorder last round" in one tap (bar / table)                                                            | E08      | Item now unavailable             |

### Merchant web dashboard (C4)

| Screen         | Content (per copy)                                                                                                                                                | Evidence |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Live orders    | Feed across QR / online / dine-in / delivery; source badge                                                                                                        | E02      |
| Order Details  | Status buttons New → In-Progress → Order-Ready → Completed; Change Pickup Time; delay text; Issue Refund (full or per item)                                       | E02, E07 |
| Menu           | Categories, items, modifiers; schedules; 86 / out-of-stock toggles                                                                                                | E02      |
| Store settings | Prep time, location, hours, Holidays & Special Hours, delivery radius (miles), pause (30 min / 1 h / 2 h / until tomorrow)                                        | E02, E07 |
| Integrations   | Connect Square / Clover / MicroSale; DoorDash; Uber Eats; payment gateway                                                                                         | E09      |
| Analytics      | KPI cards (orders, net revenue, avg tip, avg order); daily revenue chart; breakdowns by payment method, fulfilment, source; Top Items Sold; Customers (Top Spend) | E02      |
| QR codes       | Per-table codes; single venue code                                                                                                                                | E06, E07 |

### Merchant mobile app (C5, `com.ogentai.operator`)

From the Play listing summary only (E13):

- Live order queue with status updates.
- Push notification **and audio alert** on new orders.
- Auto-print to the kitchen printer.
- Today's revenue, top items, average tip.
- Menu: add, edit, hide and delete items and categories; photo upload; drag-and-drop reorder.
  This conflicts with E02 ("on the roadmap").
- Biometric login (Face ID / Touch ID / fingerprint).
- An in-app assistant for app-feature questions.

### Operator AI assistant

- A conversational surface (SMS thread and/or in-app chat, **U**). Replies should confirm the
  state change in plain language. The copy shows no other UI.

### Migration tool (`migrate-to.ogentai.com`)

- Step 1: paste a GloriaFood ordering link. Step 2: watch the menu being rebuilt ("while you
  watch"), which implies streamed, progressive output. Step 3: a storefront is created. (E11)

## To complete this spec

1. Allow `ogent.ai`, `ogentai.com` and `restaurant.ogent.ai` in the environment's network policy
   (or run in an environment that allows them).
2. Capture the marketing pages and `/get-started` at 390 px and 1440 px. Record computed fonts,
   CSS custom properties and the colour tokens.
3. With the operator's consent and a **test store only**, capture the guest flow and dashboard
   screens listed above.
4. Obtain the merchant APK (`com.ogentai.operator`) from a legitimate source for static UI and
   string analysis.
