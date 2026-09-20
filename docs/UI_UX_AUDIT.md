# UI/UX audit (before the frontend transformation)

Written 2026-09-19. It covers the code on `main` at `81f8ded` and the live app at
`https://order.beacondigitalconsulting.org`, observed in Chrome as a diner (signed-out browser,
375 px) and as an owner (signed-in dashboard). This is the "before" record. The "after" record is
[`UI_UX_FINAL_REVIEW.md`](./UI_UX_FINAL_REVIEW.md).

**Priorities**

- **P0**: directly harms the core diner experience (discover → ask → decide → order).
- **P1**: a major product-quality issue.
- **P2**: polish.

## What the diner and the owner see first today

| Question                              | Answer today                                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Where am I / what restaurant is this? | A 16 px restaurant name in the header. No logo, no description, no cover image on the menu page.         |
| What can I eat?                       | 153 text-only cards in one column, sorted by display order.                                              |
| How can the AI help me?               | A 56 px unlabelled chat bubble in the bottom-right corner. Nothing on the page says an AI waiter exists. |
| How do I order?                       | A small "Cart" text link in the header, with a count badge. No persistent cart summary.                  |
| (Owner) What is happening today?      | Four counters: menu items, categories, tables, status. No orders, no takings, no alerts.                 |

## Global

| #   | Problem                                                                                                                                                                                                                                                                  | Kind          | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | -------- |
| G1  | **Prices are hard-coded to USD** in every diner component (`menu-item-card`, `item-detail-form`, `cart-line-item`, cart page), although `restaurants.currency` exists and the AI already quotes the restaurant's currency. A non-USD restaurant would show wrong prices. | correctness   | P0       |
| G2  | No type scale: headings range from `text-base` to `text-3xl` with no shared roles; prices and names use the same weight; descriptions sit at `text-xs`.                                                                                                                  | typography    | P1       |
| G3  | Semantic tokens stop at primary/secondary/muted/accent/destructive. There is no success, warning, info or AI accent, so diet colours are raw `green-700`/`orange-700` and the AI has no visual identity.                                                                 | design system | P1       |
| G4  | Sidebar tokens are shadcn neutral greys, off-brand against the warm palette. The chart tokens are also grey.                                                                                                                                                             | visual        | P2       |
| G5  | Dark-mode tokens exist, but nothing ever applies `.dark`, so dark mode is unreachable.                                                                                                                                                                                   | design system | P2       |
| G6  | `src/app/error.tsx` calls `reset`. This Next.js fork documents `retry` (re-fetch and re-render) as the recovery to use. There are no route-level error or loading boundaries for the diner flow or the dashboard; the root spinner is the only loading state.            | states        | P1       |
| G7  | Buttons are `h-8`/`h-9` everywhere, including primary diner CTAs on a phone. The touch targets are below the comfortable 44 px.                                                                                                                                          | mobile / a11y | P1       |
| G8  | Motion: only the dialog's zoom and the chat's bounce dots. No feedback on add-to-cart, filtering or reply arrival.                                                                                                                                                       | interaction   | P2       |

## Diner: restaurant landing (`/r/[slug]`)

| #   | Problem                                                                                                          | Kind               | Priority |
| --- | ---------------------------------------------------------------------------------------------------------------- | ------------------ | -------- |
| L1  | A centred name, then 15 identical category tiles with no imagery. It reads as a settings page, not a restaurant. | visual / hierarchy | P1       |
| L2  | The AI waiter isn't mentioned; the only CTA is "View full menu".                                                 | product clarity    | P1       |

## Diner: menu (`/r/[slug]/menu`)

| #   | Problem                                                                                                                                                      | Kind                   | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | -------- |
| M1  | **Wall of text.** Every card has the same weight; name `text-sm font-medium`, description `text-xs`, price the same size as the name. Nothing leads the eye. | hierarchy / typography | P0       |
| M2  | **No dietary filters.** Vegetarian, vegan and spicy flags exist in the data but can only be found by the AI or by reading every card.                        | UX                     | P0       |
| M3  | **The AI is invisible.** Only the corner bubble, with no label.                                                                                              | product clarity        | P0       |
| M4  | No restaurant identity on the page (logo, description, cover, when present).                                                                                 | visual                 | P1       |
| M5  | The search box needs a separate "Search" button, has no clear control, and the empty state is a badge saying "No results".                                   | UX                     | P1       |
| M6  | Category chips aren't sticky, so long menus lose the navigation.                                                                                             | UX                     | P1       |
| M7  | Images are supported by the data (`image_url`) but render as a 64 px bordered square with `alt=""`. No layout is designed for photos.                        | visual                 | P1       |
| M8  | Allergen line is `text-destructive` red on every card. That's alarming at a glance, and it competes with the dish name.                                      | visual / trust         | P1       |
| M9  | No persistent cart summary; after adding, the diner must find the header link.                                                                               | UX                     | P1       |
| M10 | Single `max-w-lg` column on every screen size; desktop is a narrow strip.                                                                                    | responsive             | P2       |

## Diner: item detail (`/r/[slug]/item/[id]`)

| #   | Problem                                                                                           | Kind           | Priority |
| --- | ------------------------------------------------------------------------------------------------- | -------------- | -------- |
| I1  | The "Add to cart" CTA is at the very bottom of a long form; on a phone it's often below the fold. | UX             | P0       |
| I2  | Badge soup: Vegetarian, spice, "Contains dairy", "~3 min" all look alike.                         | hierarchy      | P1       |
| I3  | Spice choice uses browser-default radio buttons; the quantity stepper uses 28 px buttons.         | visual / touch | P1       |
| I4  | After adding, the confirmation is an inline alert above the button, easy to miss.                 | feedback       | P1       |
| I5  | No image placeholder design; without a photo, the page starts with a bare heading.                | visual         | P2       |

## Diner: AI waiter chat

| #   | Problem                                                                                                                  | Kind                  | Priority |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------- | -------- |
| A1  | **Raw markdown**: replies show `**bold**` and `\| table \|` literally (`whitespace-pre-wrap` plain text). Observed live. | visual / trust        | P0       |
| A2  | **No dish cards.** When the waiter recommends three dishes, the diner has to find them in the menu themselves.           | UX / conversion       | P0       |
| A3  | **Waiting feedback.** Real replies take 8–27 s. The only feedback is three bouncing dots.                                | perceived performance | P0       |
| A4  | Entry point is an unlabelled icon; the dialog title is "AI Waiter"; the empty state is one grey sentence.                | product clarity       | P1       |
| A5  | Starter chips are generic ("Show spicy dishes", "What's in my cart?").                                                   | copy                  | P2       |
| A6  | The dialog is a centred modal. On a phone it should be a bottom sheet that keeps the menu context.                       | mobile                | P1       |
| A7  | No reminder that answers come from the restaurant's menu and allergens still need staff confirmation.                    | trust                 | P1       |

## Diner: cart, order, receipt, booking

| #   | Problem                                                                                                        | Kind           | Priority |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------- | -------- |
| C1  | Cart lines are divided by rules with small text. Quantity controls are 28 px. "Remove" is a ghost text button. | visual / touch | P1       |
| C2  | Totals block and "Place order" have no visual weight, and there's no sticky total on mobile.                   | hierarchy      | P1       |
| C3  | Empty cart: "Your cart is empty." plus a button. There's no suggestion to ask the waiter.                      | empty state    | P2       |
| C4  | Booking form and order status pages are functional but unstyled compared with the rest.                        | consistency    | P2       |

## Owner: dashboard shell

| #   | Problem                                                                                                       | Kind          | Priority |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------- | -------- |
| D1  | 15 flat nav links with no grouping or icons. Operations, menu setup and business settings are mixed together. | IA            | P1       |
| D2  | Mobile nav is a `<details>` popover: no focus management, and it doesn't close on navigation.                 | a11y / mobile | P1       |
| D3  | Header shows the email and a role badge but no restaurant identity or status.                                 | hierarchy     | P2       |

## Owner: overview (`/dashboard`)

| #   | Problem                                                                                                                                                    | Kind    | Priority        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------- |
| O1  | **Four counters and nothing else.** No today's orders, open tickets, takings, pending bookings or setup progress, although all of these exist in the data. | product | P0 (for owners) |
| O2  | No quick actions; the owner must know where everything lives.                                                                                              | UX      | P1              |

## Owner: other screens

| #   | Problem                                                                                                                                                            | Kind                  | Priority        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- | --------------- |
| S1  | **Misleading label.** "Allow AI recommendations" actually turns the whole AI waiter on or off (`src/lib/ai/actions.ts:49`).                                        | copy / trust          | P0 (for owners) |
| S2  | **Stale copy.** "These will govern the **future** AI waiter's behavior" (Settings) and "…including the **future** AI waiter's" (Allergens). The AI waiter is live. | copy                  | P1              |
| S3  | Tax rate and service charge are entered as fractions ("0.0825").                                                                                                   | UX                    | P1              |
| S4  | Kitchen board columns overflow horizontally below ~900 px. A "Reconnecting…" badge stayed visible for the whole visit.                                             | responsive / realtime | P1              |
| S5  | Menu list shows a "Draft text" badge on all 153 rows, so the badge carries no information.                                                                         | visual                | P2              |
| S6  | Tables, reports, payments and staff pages are consistent with each other but plain.                                                                                | visual                | P2              |

## Accessibility (current)

**What is already good:** the chat is a `role="log"` live region, there are screen-reader speaker prefixes, the dialog close button is real, the menu page has a visually hidden `h1`, allergen text doesn't rely on colour, and `motion-safe` is used.

**Gaps:**

- Card images have `alt=""` even when they're the only depiction of the dish.
- Touch targets are below 44 px (G7).
- Mobile nav is `<details>` (D2).
- Category chip links have no `aria-current`.
- The spice radios' focus ring is browser-default.

## Performance (current)

Pages are light (server-rendered, no client data fetching for the menu), which is a strength to keep. The menu renders up to 500 items with no pagination. That's fine at 153, and virtualization isn't needed yet. There are no images to optimize today.
