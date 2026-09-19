# Design system

AI Waiter should feel like **a premium restaurant experience with a waiter in it**: warm, food-first
and quiet. It shouldn't look like a generic AI SaaS app. This document records the tokens and rules the
frontend uses. The source of truth is `src/app/globals.css`; the shared components live in
`src/components/ui/` and `src/components/customer/`.

## Principles

1. **Food first, chrome last.** A dish name must always be the strongest thing on its card. UI
   furniture (borders, badges, icons) stays one step quieter than content.
2. **The waiter is a capability, not a widget.** The AI is introduced in words ("Ask the waiter"),
   gets its own accent colour, and its answers link back to real dishes.
3. **Trust is visible.** Allergens are stated "as listed by the restaurant", never implied safe.
   Nothing on screen is invented: no fake popularity, ratings or metrics.
4. **One thing first.** Every screen answers: what should I notice first, second, and what do I do?
5. **Restraint.** No gradients, glass, glows or giant shadows. Premium comes from spacing,
   typography and consistency.

## Colour

All colours are semantic tokens in OKLCH, defined on `:root` (light) and `.dark`. Components never
use raw palette colours like `green-700`.

| Token                              | Role                                                            | Light                                             |
| ---------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| `background` / `foreground`        | Page and body text: warm cream and espresso                     | `0.985 0.006 75` / `0.2 0.02 40`                  |
| `card`                             | Raised surfaces                                                 | `1 0.002 75`                                      |
| `muted` / `muted-foreground`       | Quiet fills and secondary text (AA on background)               | `0.955 0.012 70` / `0.47 0.02 50`                 |
| `primary` / `primary-foreground`   | Terracotta: the brand and the main action                       | `0.42 0.13 40` / `0.985 0.01 75`                  |
| `secondary`, `accent`              | Soft warm fills for chips and hovers                            | `0.95 0.015 70`, `0.93 0.035 70`                  |
| `success` (+ `-foreground`)        | Vegetarian/vegan, "paid", "ready"                               | herb green `0.5 0.11 150`                         |
| `warning` (+ `-foreground`)        | Needs attention: pending bookings, unconfirmed data             | amber `0.74 0.14 72`                              |
| `info` (+ `-foreground`)           | Neutral information                                             | slate blue `0.52 0.07 245`                        |
| `destructive`                      | Errors and irreversible actions only (not allergens)            | `0.577 0.215 27`                                  |
| `spice`                            | Spice indicator                                                 | chilli `0.56 0.17 33`                             |
| `ai` / `ai-soft` / `ai-foreground` | The waiter's identity: saffron accent, its bubble fill and text | `0.64 0.13 68` / `0.965 0.028 80` / `0.3 0.05 50` |

Allergens use **`warning` tones, not `destructive`**. "Contains milk" is information a diner needs to
see, not an error. The word "Contains" carries the meaning (WCAG 1.4.1).

Dark-mode tokens are defined but not applied anywhere. Turning dark mode on is a product decision
(see the final review), not something this pass does silently.

## Typography

Geist Sans throughout, Geist Mono for codes. Roles are Tailwind utilities defined with `@utility`
in `globals.css`, so every screen uses the same scale.

| Utility         | Use                                           | Size / line-height           | Weight | Tracking        |
| --------------- | --------------------------------------------- | ---------------------------- | ------ | --------------- |
| `type-display`  | Restaurant name in the hero, landing headline | 2rem / 1.1 (2.5rem on `sm+`) | 650    | -0.03em         |
| `type-title`    | Page title (h1)                               | 1.5rem / 1.2                 | 600    | -0.025em        |
| `type-heading`  | Section heading (h2)                          | 1.125rem / 1.3               | 600    | -0.015em        |
| `type-dish`     | Dish name on cards (h3)                       | 1rem / 1.3                   | 600    | -0.01em         |
| `type-body`     | Paragraphs, chat                              | 0.9375rem / 1.55             | 400    | 0               |
| `type-body-sm`  | Descriptions, secondary text                  | 0.875rem / 1.5               | 400    | 0               |
| `type-caption`  | Metadata, helper text                         | 0.8125rem / 1.4              | 400    | 0               |
| `type-label`    | Form labels, chip text                        | 0.8125rem / 1.3              | 500    | 0.005em         |
| `type-overline` | Small section eyebrows                        | 0.6875rem / 1.2, uppercase   | 600    | 0.08em          |
| `type-price`    | Every price                                   | inherits size                | 600    | tabular numbers |

Rules:

- A dish name is always `type-dish` or larger, and its description is always `type-body-sm`
  `muted-foreground`, so the two never compete.
- Prices are always right-aligned or trailing, `type-price` with tabular numbers, and formatted in
  **the restaurant's currency** via `formatPrice()` (`src/lib/format/price.ts`), never a
  hard-coded USD.

## Spacing and layout

- A 4 px base. The rhythm steps are **4, 8, 12, 16, 24, 32, 48**.
- Page gutter: 16 px on phones, 24 px from `sm`.
- Within a card: 12–16 px. Between cards: 12 px. Between page sections: 24–32 px.
- Diner pages are a single, phone-first column up to `max-w-2xl`. The menu grid becomes two columns
  from `md`.
- Dashboard: a 248 px sidebar from `lg`, content capped at `max-w-6xl`.

## Radius

`--radius: 0.625rem` (10 px) is the base.

| Surface            | Radius               |
| ------------------ | -------------------- |
| Inputs and buttons | `rounded-lg` (10 px) |
| Cards and sheets   | `rounded-xl` (14 px) |
| Chips and pills    | `rounded-full`       |
| Dish thumbnails    | `rounded-lg`         |

Nothing goes beyond `rounded-2xl`.

## Elevation

| Token          | Use                                                                               |
| -------------- | --------------------------------------------------------------------------------- |
| `shadow-card`  | Resting cards: hairline plus a 1 px soft shadow. Mostly the border does the work. |
| `shadow-float` | Things above the page: the bottom dock, sheets, popovers                          |

There are no other shadows.

## Motion

| Token             | Value                        | Use                       |
| ----------------- | ---------------------------- | ------------------------- |
| `--ease-out-soft` | `cubic-bezier(0.2, 0, 0, 1)` | Everything entering       |
| fast              | 150 ms                       | Hover, press, chip toggle |
| base              | 200 ms                       | Cards, reply arrival      |
| slow              | 280 ms                       | Sheets                    |

- Chat replies fade and rise 4 px as they arrive. The add-to-cart confirmation pops once. Sheets
  slide from the bottom on phones.
- `prefers-reduced-motion: reduce` collapses all animations and transitions to near-instant
  (global rule in `globals.css`), and every decorative animation also uses `motion-safe:`.

## Components

| Component                      | File                               | Notes                                                                      |
| ------------------------------ | ---------------------------------- | -------------------------------------------------------------------------- |
| `Button`                       | `ui/button.tsx`                    | `lg` is now 44 px tall for diner CTAs                                      |
| `FilterChip`                   | `customer/filter-chip.tsx`         | A link chip with `aria-current` / `aria-pressed` semantics                 |
| `DietBadges`                   | `customer/diet-badges.tsx`         | Veg / vegan / spicy from menu flags only                                   |
| `AllergenNote`                 | `customer/allergen-note.tsx`       | Warning-toned "Contains …, as listed by the restaurant"                    |
| `MenuItemCard`                 | `customer/menu-item-card.tsx`      | Text-first row; the photo slot appears only when a photo exists            |
| `RestaurantHero`               | `customer/restaurant-hero.tsx`     | Name, description, logo/cover when present; nothing invented               |
| `AskWaiterCard`                | `customer/ask-waiter-card.tsx`     | Introduces the AI with real starter prompts                                |
| `DinerDock`                    | `customer/diner-dock.tsx`          | Sticky bottom bar: "Ask the waiter" + cart summary                         |
| `ChatMessage` / `ChatMarkdown` | `customer/chat-markdown.tsx`       | Safe markdown subset rendered as React elements (no HTML injection)        |
| `RecommendationCard`           | `customer/recommendation-card.tsx` | Dish card from structured data returned by the server                      |
| `EmptyState`                   | `ui/empty-state.tsx`               | Title + reason + action, used by diner and dashboard                       |
| `StatCard`, setup checklist    | `app/dashboard/page.tsx`           | Overview building blocks; real data only (`src/lib/dashboard/overview.ts`) |
| `MobileNav`                    | `dashboard/mobile-nav.tsx`         | Base UI drawer for the dashboard nav below `lg`                            |
| `DialogSheetContent`           | `ui/dialog.tsx`                    | Bottom sheet on phones, corner panel from `sm` (the waiter)                |

## Iconography

`lucide-react` only, at 16 px (inline) or 20 px (standalone), stroke 2. Icons support a label; they
never replace one. Every icon-only button has an `aria-label`.

## Copy

Warm, brief and specific, like a good host. No "AI-powered", no "revolutionary", no exclamation
marks, no "the future of". Tell people what happens and what to do next ("Add your first dish to
start your menu").

Progress text must be true. The chat only knows that a request is in flight, not which tool is
running, so it says "Your waiter is thinking…" and later "Still working on it…". It never says
"Checking the menu…" unless the server actually reports that stage.
