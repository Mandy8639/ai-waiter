# Importing a menu from photographs

A restaurant setting up AI Waiter should not have to type in 150 items. They photograph their menu
boards, a vision model reads them, and **a human confirms the result before anything reaches the
live menu.**

That last clause is the feature. Everything else is plumbing.

## Why the review step is not optional

A menu is the price list a customer is charged from. A single mis-read digit is a restaurant
undercharging for a month, and this project already has a documented incident of a model
confidently reporting an action it never performed
([`docs/ai.md#cart-grounding`](./ai.md#cart-grounding)).

The gaps are not hypothetical either. Transcribing Nashta's real boards by hand, in this repo, on
2026-09-04:

- **14 items had no price at all** — "ask at counter", by weight
- **Four prices were unreadable** and had to be flagged for confirmation
- **One category heading was missing** entirely and had to be guessed
- Dietary flags are a claim about food, not a transcription

An extractor that quietly fills those in produces wrong prices in front of real customers. So the
pipeline is deliberately four steps with a person in the middle:

```
upload → extract (drafts) → review & correct → commit
```

## Never inventing a price

The rule is enforced in three places, not one:

| Layer    | Enforcement                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------- |
| Prompt   | `EXTRACTION_PROMPT` says "NEVER invent, estimate, or infer a price… use null"                       |
| Parser   | `menu_import_items.price` is nullable; the Zod schema accepts `number \| null` and rejects a string |
| Database | `commit_menu_import()` raises `MENU_IMPORT_UNPRICED_ITEMS` rather than defaulting to 0              |

`menu_import_items.price` being nullable where `menu_items.price` is `NOT NULL` is the whole point
of a separate staging table: "the board gives no price" must be _representable_ before it can be
resolved.

## The model

`dots-studio/dots-3-note-preview:free` — pinned separately from the chat model, and vetted the same
way the chat fallback list is ([`docs/ai.md#model-fallback`](./ai.md#model-fallback)).

Measured 2026-09-04 against a dense, slightly blurred board of 23 items across 4 categories:
**23/23 correct on three consecutive runs, every "ask at counter" item returned as `null`, nothing
invented**, in roughly 20 seconds. Free tier.

Override with `MENU_IMPORT_VISION_MODEL`. Re-vet before changing it: "supports image input" is not
the bar — _"does not invent a price"_ is. Several free models advertise vision and are unusable;
one never responded to a single board at all.

Extraction deliberately does **not** go through `src/lib/ai/providers/`. That seam models a
conversation — history, tools, a tool-call loop, refusal handling. This is one image-in, JSON-out
call with none of those, and forcing it through would distort an interface whose value is that
`loop.ts` never has to know two providers exist. It shares the credential and endpoint, nothing
else.

## Security

- `menu_imports` and `menu_import_items` are **manager/owner only**, not all staff: this writes the
  restaurant's price list.
- `commit_menu_import()` is `SECURITY DEFINER`, so it re-checks the caller explicitly rather than
  relying on the RLS it bypasses.
- It refuses to run twice (`MENU_IMPORT_ALREADY_COMMITTED`) — a second run would duplicate every
  item.
- Uploads go to a **private** `menu-imports` bucket, namespaced by restaurant id, with storage
  policies scoped on that first path segment. Menu photos can incidentally contain staff or
  handwritten notes, so nothing is publicly readable.

### One fix this feature forced

`is_restaurant_manager_or_owner()` was:

```sql
select public.current_restaurant_role(x) in ('owner', 'manager')
```

`current_restaurant_role()` returns NULL for a non-member, and **`NULL IN (...)` is NULL, not
false.** Harmless in an RLS `USING` clause, where NULL and false both deny — which is why every
existing use was fine. Not harmless in plpgsql: `if not <NULL> then` does not take the branch, so
an authorization guard written the obvious way passes for a complete outsider.

`commit_menu_import()` was the first function to guard with this helper, and an outsider
successfully committed an import in the integration tests before it was fixed with `coalesce`.
`is_restaurant_member()` was never affected — `... is not null` already returns a real boolean.

## Known limits

- **The assembled flow has not been run end to end against a real project.** The migration needs
  `supabase db push` first. The extraction path and the commit function are each tested; the two
  have not been exercised together through the UI.
- **Tested against generated images, not photographs.** Real menus have glare, angles, curled
  laminate and handwriting. Worth a pass with an actual phone photo of a real board before trusting
  it in front of a restaurant.
- **Dietary and allergen flags are not extracted.** Guessing "contains nuts" from an item name is
  how someone gets hurt; unset means the AI correctly says the menu doesn't specify.
- **Uploaded pages are not yet persisted.** The bucket exists and is policied, but extraction reads
  the bytes directly from the browser, so there is currently no stored copy of what was read.
