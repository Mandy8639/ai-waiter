# The menu knowledge graph

The AI waiter's questions that cross the whole menu — "I'm allergic to dairy, what can I eat?", "what
goes with the dal makhani?" — are answered from a graph of the restaurant's menu, not from a list the
model has to read and reason over. Code: `src/lib/menu-graph/`; tools:
`src/lib/ai/tools/menu-graph.ts`.

## What's in it

| Node       | From                                                               |
| ---------- | ------------------------------------------------------------------ |
| Dish       | `menu_items` being served right now                                |
| Section    | `categories` on a menu that's on now                               |
| Ingredient | `menu_item_ingredients` (what the restaurant listed)               |
| Allergen   | ten groups (`allergen-lexicon.ts`): dairy, egg, fish, shellfish, … |
| Diet       | the restaurant's own vegetarian / vegan / halal / kosher flags     |

Every edge records where it came from, because that decides what the waiter may say:

| Edge                      | Source     | Example                                      |
| ------------------------- | ---------- | -------------------------------------------- |
| dish → allergen           | `stated`   | a confirmed allergen, a ticked "contains"    |
| dish → allergen           | `inferred` | "made with Ghee", "its name mentions paneer" |
| dish → ingredient, diet   | `stated`   | listed by the restaurant                     |
| dish → dish, ordered with | `orders`   | "ordered together 14 times recently"         |

## The one-way rule

Inference can only add caution. A word in an ingredient or a dish's name ("paneer", "ghee", "naan")
puts the dish in **likely contains**, with the reason. Nothing ever moves a dish the other way: a dish
with no edge to the allergen is **not marked as containing** it, never "free of" it. That is the rule
the rest of Tableside already keeps (`src/lib/menu/diet-filters.ts`, the allergen confirmation
migration): a missing allergen means the restaurant hasn't said, and a wrong "yes, that's safe" to
someone with an allergy is an ambulance.

So `check_menu_allergens` returns three lists — `containsPerRestaurant`, `likelyContains`,
`notMarkedAsContaining` — plus the rule in words, and the system prompt tells the waiter to offer the
last list as dishes to confirm with staff. Dish cards under the reply come only from that list and
from pairings, never from a dish to avoid.

## Ordered together

`menu_pairings()` (migration `20261122090000`) counts, per pair of dishes, the separate visits (a
diner's session, or a staff-rung order) that ordered both in the last 90 days, excluding cancelled
orders. Counts only, never who or when, and only pairs seen in at least 3 visits, so a quiet
restaurant can't reveal one guest's order. With no pairings, the waiter may suggest a bread or drink as
an idea but must not call it popular.

## Tested

- `tests/unit/menu-graph.test.ts`: the vocabulary, the three buckets, one bucket per dish, filters,
  pairings, the guards and dish cards.
- `tests/integration/db/menu-pairings.test.ts`: the 3-visit threshold, rounds counted once, cancelled
  orders ignored, signed-out callers refused.
- The waiter evaluation (`npm run eval:waiter`) runs both tools against the same graph code:
  `dairy-allergy-menu-wide`, `pairing-from-orders`, `pairing-not-enough-orders`.

## Owners confirm what the graph infers

An inferred allergen is only ever a warning. To turn it into a fact the restaurant states, the allergen
review screen (`/dashboard/menu/allergen-review`, linked from Menu as "Check allergens") has **Find
likely allergens**. It runs the graph over the whole menu (`suggest-core.ts`) and adds each inferred
allergen that nothing stated yet to the existing review queue, as an unconfirmed suggestion with its
reason ("its name mentions paneer"), named in the screen's own vocabulary (Milk, Wheat, Tree nuts…).
`suggest_menu_allergens()` (migration `20261123090000`) skips anything already on a dish and anything
turned down before: `confirm_menu_item_allergens()` now records a rejected suggestion in
`allergen_dismissals`, and ticking it later lifts that. Owners and managers only, and nothing reaches a
diner until it's confirmed, exactly as for menu-import suggestions. Once confirmed, the waiter's
allergy check reports the dish under "the restaurant says it contains".
