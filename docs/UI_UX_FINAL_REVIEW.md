# UI/UX final review (after the frontend transformation)

Written 2026-09-19, on branch `frontend-transformation`. The "before" record is
[`UI_UX_AUDIT.md`](./UI_UX_AUDIT.md), and the tokens and rules are in
[`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md). This page covers what changed, what was actually
verified, and what is still missing. It doesn't claim 10/10, because the product isn't there yet.

## What changed

### Diner experience

- **Menu page** (`/r/[slug]/menu`):
  - A restaurant hero shows only real data: name, description, and logo, cover and address when
    present.
  - One line states "Everything on this menu is vegetarian" when the restaurant's own flags say so,
    instead of a label on all 153 cards.
  - An **"Not sure what to order?"** card introduces the AI waiter with three prompts that open it
    and ask straight away.
  - Search has an icon, a clear button and a proper empty state.
  - **Dietary filter chips** appear only for filters that would narrow this menu. There's no
    "nut-free" or "dairy-free" filter, because missing allergen data is not a safety promise.
  - A sticky category bar, and dishes grouped under the restaurant's own categories.
  - Redesigned dish cards: the name leads, the description supports, then price and dietary
    labels. Allergens use warning tones instead of error red. A photo slot appears only when a
    photo exists.
- **Dish page**:
  - A back link and a hero image when one exists.
  - Name and price are the clear first read, with dietary and prep-time labels.
  - Allergens are merged with the dish's own flags, so the page never says "no allergens listed"
    while a flag says it contains dairy.
  - "Ask the waiter about this dish".
  - Option groups are cards. Spice choices are pill buttons, and they're **offered only for dishes
    marked spicy or given a heat level** (a cold coffee no longer asks how hot you want it).
  - A larger quantity stepper, and a **sticky "Add to order · price" bar** with inline
    confirmation and a "View order" link.
- **Bottom dock**: "Ask the waiter" plus "View order (n)". It replaces the anonymous 56 px chat
  bubble. It's hidden on dish pages (the add bar owns the bottom there) and on the cart page.
- **Cart**:
  - "Your order", with each line as a card: thumbnail, options, spice and note, 36 px steppers, and
    a labelled remove button.
  - A summary card with the total and the place-order action.
  - Notices use one consistent style.
  - Empty state: "Browse the menu" plus "Ask the waiter".
- **Restaurant landing**: hero, "See the menu" / "Book a table", the waiter card, and categories as
  chips.
- **Prices use the restaurant's currency** everywhere in the diner flow (`formatPrice`). Before,
  they were hard-coded to USD.

### AI experience

- **A bottom sheet on phones, a corner panel on desktop.** It keeps the menu visible.
- **A waiter identity**: its own saffron accent, avatar, "Your waiter — answers from {restaurant}'s
  menu", and a standing trust line: "For allergies, please also check with staff."
- **Formatted replies**: bold, lists, headings and tables render properly. The old version showed
  raw `**` and pipe characters. The renderer (`src/lib/ai/chat-format.ts` + `ChatMarkdown`) never
  emits HTML and drops link URLs.
- **Dish cards from structured data**. The server returns the real menu rows this turn's tools
  retrieved, filtered to the dishes the reply names. Each card has price, dietary flags, confirmed
  allergens, "View dish", and one-tap "Add" (or "Choose options" when a required option exists).
  The contract is documented in `docs/ai.md#dish-cards-under-replies`, with no extra model call and
  no parsing of ids from prose.
- **Honest waiting states**: "Your waiter is thinking…", then "Still working on it…", then "Taking a
  little longer than usual". The server doesn't report which tool is running, so the text never
  claims a stage it can't see.
- **A useful welcome state** with starter prompts the waiter really handles well. "What's quick to
  make?" was considered and dropped because it would exhaust the tool budget.
- **Focus returns to whichever button opened the sheet**, passed explicitly because Safari doesn't
  focus buttons on click.

### Restaurant dashboard

- **Grouped sidebar** with icons (Service / Menu / Business), a restaurant identity block and a
  warm sidebar palette. On phones, a real Base UI **drawer** replaces the `<details>` popover: focus
  is trapped, Escape works, and it closes on navigation.
- **The overview** answers "what's happening today", using real data only:
  - A service status pill (open / not taking orders / paused).
  - An **attention list** (orders awaiting acceptance, booking requests, unconfirmed allergen
    suggestions), each linking to where you act on it.
  - KPI cards: orders today, in the kitchen now, taken today (owner/manager only), dishes on the
    menu.
  - Today's orders, a setup checklist that hides itself when complete, and quick actions.
- **Settings copy that tells the truth**:
  - "AI waiter" replaces "Allow AI recommendations", with a note that it switches the whole waiter
    on and off.
  - Every toggle has a description.
  - Tax and service charge are entered as **percentages** (the stored fraction and the server
    action are unchanged).
  - The "future AI waiter" copy on Settings, Allergens and Ingredients is gone.
- **Kitchen board**: each status column is a panel, and on phones the board snaps one column at a
  time.

### Design system

- **Semantic tokens**: success, warning, info, spice, and an AI trio (`ai`, `ai-soft`,
  `ai-foreground`). Sidebar and chart tokens are now on-brand. Elevation is two shadows,
  `shadow-card` and `shadow-float`.
- **Ten type roles** as Tailwind utilities (`type-display` … `type-price`) with tabular prices.
- **Button sizes**: the default is 36 px, and `lg` is 44 px for diner CTAs.
- **Motion**: a global `prefers-reduced-motion` rule, and entrance animations only where they
  explain something (reply arrival, add confirmation, sheet and drawer).
- **Shared components**: `FilterChip`, `DietBadges`, `AllergenLine`/`AllergenNote`,
  `RestaurantHero`, `AskWaiterCard`/`AskWaiterButton`, `DinerDock`, `ChatMarkdown`,
  `RecommendationCard`, `EmptyState`, `DialogSheetContent`, `MobileNav`.

### States

- Skeleton loading for the menu and the dashboard.
- Route-level error boundaries for the diner flow and the dashboard. The root and global error
  boundaries now use this Next.js fork's `retry()`.
- Designed empty states for search, the cart, "no session" and "restaurant paused".

## What was verified, and how

| Check                                                                    | Result                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit and integration tests                                               | **1,395 passed** (1,366 existing + 29 new: chat formatting, recommendation selection, diet filters, price formatting)                                                                                                                                                                                                                        |
| Typecheck, lint (`--max-warnings=0`), Prettier                           | Clean                                                                                                                                                                                                                                                                                                                                        |
| Production build (`next build`)                                          | Succeeds                                                                                                                                                                                                                                                                                                                                     |
| Diner flow in the browser, 375 px, local build against the live database | Menu hero, filters and sections render. The "Something light" prompt opened the waiter, which replied with three suggestions, each rendered as a dish card with real price and allergens. "Add" on a card updated the order count. The cart rendered, "Remove" worked, and the empty state appeared. The dish page's sticky add bar renders. |
| Restaurant landing at 320 px                                             | No horizontal overflow                                                                                                                                                                                                                                                                                                                       |
| Dashboard in the browser (desktop 1366 px and 375 px)                    | Overview with real figures; the settings copy; the drawer opens on tap and closes on navigation; kitchen board columns                                                                                                                                                                                                                       |

**Side effects on production data during testing:**

- Anonymous diner sessions were created from local QR scans.
- One AI conversation turn was stored.
- One cart line was added and then removed.
- No orders or payments were created.

**Not verified:**

- The E2E specs were updated to the new copy but **not run**. They write to the production
  database, which is an open issue from the production audit.
- The dock after the 320 px label fix was not re-checked visually. It needs a diner session, and
  this browser's session is an operator one.
- Keyboard-only focus return from the waiter sheet was checked in code, not with a real keyboard
  pass.
- Dark mode was not checked, because it isn't enabled.

## Scorecard

These are my own ratings, and the "after" figures describe this branch, not production.

| Area                 | Before | After | What holds it back                                                                                                             |
| -------------------- | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------ |
| Visual hierarchy     | 3      | 8     | Inner dashboard pages still use the old styling                                                                                |
| Typography           | 3      | 8     | Type roles aren't yet applied on every dashboard form                                                                          |
| Layout               | 4      | 7.5   | Desktop diner layout is a comfortable column, not a designed desktop experience                                                |
| Consistency          | 5      | 7     | Two generations of screens coexist (see gaps)                                                                                  |
| Mobile UX            | 4      | 8     | The dock and sheet need a real-device pass (safe areas, keyboard overlap)                                                      |
| Desktop UX           | 4      | 7     |                                                                                                                                |
| Diner experience     | 3      | 8     | No food photos in the data; the menu still reads text-first                                                                    |
| AI experience        | 3      | 7.5   | Latency (8–27 s) and tool-limit failures are unchanged; they're backend work                                                   |
| Menu experience      | 3      | 7.5   | Photos; the table isn't shown (needs a new DB function)                                                                        |
| Restaurant dashboard | 3      | 7     | Only the shell, overview, settings and kitchen were redesigned                                                                 |
| Accessibility        | 6      | 7.5   | Needs an axe/screen-reader pass on the new components                                                                          |
| Performance          | 7      | 7     | +1 small query per menu load (dietary flags) and +3 per chat reply (card details); both measured as fine locally, not profiled |
| Micro-interactions   | 2      | 6     | Deliberately restrained; no optimistic cart updates yet                                                                        |
| Trust                | 6      | 8.5   | Honest waiting states, allergen framing, "On the menu" wording, trust line                                                     |
| Product clarity      | 3      | 8     | The 5-second test now passes on the menu page: the waiter is named and offered up front                                        |

**Overall: about 7.5/10.** The diner menu, dish page, cart and AI sheet are close to
production-grade. Getting the whole product there needs the gaps below.

## Remaining gaps

1. **AI speed and reliability.** Replies take 8–27 s on free models, and a normal compound question
   hit the 6-tool-call limit. No frontend change fixes that. It needs the paid-model/Anthropic path
   measured, and the tool budget reviewed.
2. **Food photos.** The UI is ready for them, but there's no upload pipeline (Supabase Storage isn't
   wired up) and the live menu has none.
3. **Replying in the diner's language.** The waiter understands Spanish but replies in English, and
   the UI is English-only.
4. **Showing "Table 5" on the menu** needs a narrow `SECURITY DEFINER` function like
   `get_order_table`. Diners can't read `tables` directly, by design.
5. **Screens not redesigned in this pass**: the owner landing page, login, signup, onboarding; the
   diner's order-status, orders, receipt and booking pages; and the dashboard's menu list, forms,
   tables, reports, payments, staff and reservations. They inherit the new tokens and buttons but
   not the new layouts.
6. **Two `EmptyState` components** (`ui/empty-state.tsx`, new; `dashboard/empty-state.tsx`, old)
   should be merged.
7. **Hard-coded USD outside the diner flow**: the dashboard menu and modifier pages, and
   `src/lib/payments/tab.ts` / `tab-queries.ts`.
8. **Dish cards aren't persisted**: reopening the chat shows past replies as text only.
9. **Dark mode**: tokens are defined but never applied. Enabling it (by OS preference or a toggle)
   is a product decision, and it needs its own visual pass.
10. **E2E specs**: updated but not run. They need a disposable database before they're safe to run
    routinely.
