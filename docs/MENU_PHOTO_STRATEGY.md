# Menu photo strategy

**Status: Phase 1 (data model) implemented; later phases not started.** Written 2026-09-19. The
decisions are recorded in [§18](#18-decisions-approved-2026-09-19). What Phase 1 actually built,
including where it differs from the original sketch, is in [§19](#19-phase-1-as-built).

## The principle

The goal is **not** "AI generates restaurant photos". It is:

> A restaurant can launch a good-looking menu straight away, then gradually replace temporary AI
> images with real photographs.

A real photo is always the preferred long-term image for a dish. An AI image is a placeholder the
owner chose knowingly, labelled for diners, and nudged toward replacement. No image is still a
valid, well-designed state.

## What exists today (inspected, not assumed)

| Area                   | Current state                                                                                                                                                                                                                                                                                                                                                                             | Consequence for this plan                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dish image field       | `menu_items.image_url text`, a free-text URL typed into the dish form (`src/components/menu/menu-item-form.tsx`). No origin, no status.                                                                                                                                                                                                                                                   | The image's origin can't be known from the data. New explicit fields are needed.                                                                                                                                                                                |
| Live data              | Nashta has 153 dishes and **0 images**.                                                                                                                                                                                                                                                                                                                                                   | Migration risk in production today is close to zero. Recount other restaurants at migration time.                                                                                                                                                               |
| Storage                | Supabase Storage is provisioned. `20260904120000_menu_imports.sql` creates a **private** bucket `menu-imports`: 10 MB limit, jpeg/png/webp/pdf, RLS on `storage.objects` scoped by `(storage.foldername(name))[1]` = restaurant id via `is_restaurant_manager_or_owner()`. **No code uploads to it yet**: import pages are sent to the vision model as data URLs through a server action. | The tenant-isolation pattern already exists and has been reviewed. Reuse it. No new storage provider is needed.                                                                                                                                                 |
| Upload size            | Server actions have a **1 MB request-body default** in this Next.js fork (`node_modules/next/dist/docs/.../serverActions.md`), and `next.config.ts` doesn't raise it.                                                                                                                                                                                                                     | Photos must go **browser → Storage directly** via a signed upload URL, not through a server action. (This also suggests the existing menu-import upload, which posts up to 8 pages as data URLs, may fail for large photos. That's worth verifying separately.) |
| Image processing       | `sharp` is installed only as Next.js's optional dependency (`package-lock.json`). It's not a direct dependency of the app.                                                                                                                                                                                                                                                                | Server-side variants need `sharp` added explicitly. That's a dependency decision.                                                                                                                                                                               |
| Diner rendering        | The redesigned cards and dish page already reserve the image slot and render nothing when there's no photo (`src/components/customer/menu-item-card.tsx`). Plain `<img>`, because owner URLs have unknown hosts.                                                                                                                                                                          | Image support slots into existing components. The no-photo fallback already exists.                                                                                                                                                                             |
| AI providers           | Anthropic (chat) and OpenRouter free models (chat, vision) — `src/lib/ai/config.ts`. **None of the configured models generates images.**                                                                                                                                                                                                                                                  | Image generation needs a separate, explicitly configured model list and paid access. That's a provider decision.                                                                                                                                                |
| Human-review precedent | Menu import writes to staging tables (`menu_imports`, `menu_import_items`), and a person commits via `commit_menu_import()`. Allergen and spice suggestions need explicit confirmation.                                                                                                                                                                                                   | AI images follow the same pattern: staged, reviewed, then published by a person.                                                                                                                                                                                |
| Rate limiting          | Session-scoped limits are counted from real rows (`src/lib/ai/rate-limit-core.ts`).                                                                                                                                                                                                                                                                                                       | Generation caps count real `menu_item_images` rows. No new infrastructure.                                                                                                                                                                                      |
| Analytics              | No product analytics service. The AI layer logs structured JSON lines (`src/lib/ai/logging.ts`, "a drop-in source for any real log pipeline later"). Sentry is used for errors.                                                                                                                                                                                                           | Events become structured log lines of the same shape, not a new SDK.                                                                                                                                                                                            |
| Billing / usage        | Platform plans charge a fee per card payment (`platform_plans`). There's no usage metering.                                                                                                                                                                                                                                                                                               | Charging for generation is a **future dependency**. Caps work without it.                                                                                                                                                                                       |
| Backups                | `npm run db:backup` covers the `public` schema only.                                                                                                                                                                                                                                                                                                                                      | Photos wouldn't be in backups. This needs a decision (§18).                                                                                                                                                                                                     |
| Roles                  | Menu writes are owner/manager (`is_restaurant_manager_or_owner`).                                                                                                                                                                                                                                                                                                                         | Upload and generation are owner/manager, the same boundary as menu import.                                                                                                                                                                                      |

---

## 1. Onboarding

A step called **"Bring your menu to life"** appears in two places:

- straight after a menu import is committed (the existing flow redirects from
  `/dashboard/menu/import/[id]`), and
- on the setup checklist of the new dashboard overview, as "Add photos to your menu".

```text
Bring your menu to life
Dishes with a picture are easier to choose. You can mix both, dish by dish.

[ Upload your photos ]            [ Generate with AI ]
Use real photos of your food.     A temporary picture for a dish until you
                                  have a real photo. Diners see it labelled
                                  "AI-generated image".

                    Skip for now — you can add photos anytime
```

- **There's no global strategy switch.** Both buttons open the same photo manager (§8), filtered
  differently. Every dish independently holds a real photo, an AI image or no image.
- Skipping is a first-class choice. The menu stays text-first and fully usable.

## 2. Per-dish image state

The state is **stored, never inferred** from a filename, URL or host.

| State          | Meaning                                                                      | Stored as                                          |
| -------------- | ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `NO_IMAGE`     | Nothing to show; the diner sees the text-only card                           | `menu_items.active_image_id IS NULL`               |
| `REAL`         | A photo the restaurant supplied                                              | the active image row has `source = 'real'`         |
| `AI_GENERATED` | An image generated for this dish and accepted by the owner                   | the active image row has `source = 'ai_generated'` |
| `UNVERIFIED`   | A pre-existing image URL nobody has vouched for yet (legacy only; see §18.5) | the active image row has `source = 'unverified'`   |

These three are **what the diner sees**. Separately, each image _row_ has a lifecycle status (§3,
§9). A dish can be `REAL` while also holding an AI draft awaiting review. Drafts never change what
the diner sees.

## 3. Image lifecycle

Each upload or generation creates a **new image row**, and image rows are never overwritten. A dish
points at exactly one active row. Switching images is one database transaction that moves that
pointer.

```text
                 ┌──────────── upload ────────────┐
NO_IMAGE ──generate──► [draft: pending_review] ──accept──► AI_GENERATED
   ▲                        │ reject                          │
   │                        ▼                                 │ upload real → preview → Replace
 remove                 rejected                              ▼
   │                                                        REAL ──upload another → preview → Replace──► REAL
   └──────────────────── remove (any active) ◄────────────────┘
AI_GENERATED ──regenerate──► new draft (the current image stays active until the new one is accepted)
```

Image row statuses: `uploading` → `pending_review` → `active` → `superseded` /
`removed`. Also `generating`, `rejected` and `failed`.

**Never destroy a valid image before its replacement succeeds.** The rules:

1. A new image is fully uploaded, validated, processed and written to its final variants
   **before** anything points at it.
2. Publishing is a single `SECURITY DEFINER` function
   (`publish_menu_item_image(image_id)`, §9) that, in one transaction:
   - checks the caller is a manager or owner;
   - checks the image is `pending_review` for this dish;
   - marks the old active row `superseded`;
   - marks the new row `active`; and
   - updates the pointer on `menu_items`.
3. Any failure (upload, processing, generation, publish) leaves the current active image
   untouched. The failed row is marked `failed` with a customer-safe reason.
4. Superseded image files are **kept for a retention period** (decision §18.7), so a mistaken
   replace can be undone. Cleanup is a separate step, never part of publishing.

## 4. Owner UX

**Menu list** (`/dashboard/menu`):

- Each row gets a 40 px thumbnail and a status badge:
  - **Restaurant photo** (neutral);
  - **AI-generated** (saffron `ai` token, sparkle icon);
  - **Add a photo** (outline, links to the dish's photo panel).
- Filters: _Missing photos_ · _AI-generated_ · _Restaurant photos_.
- The overview gets a line such as "Photos: 12 restaurant · 30 AI-generated · 111 none", with a
  link. The figures come from counts.

**Dish photo panel** (inside the dish editor, `/dashboard/menu/[id]/edit`):

| Current state         | Primary action                    | Secondary actions             |
| --------------------- | --------------------------------- | ----------------------------- |
| No photo              | **Upload photo**                  | Generate with AI              |
| AI-generated          | **Replace with real photo**       | Regenerate · Remove · Preview |
| Restaurant photo      | Replace                           | Remove · Preview              |
| Draft awaiting review | **Review** (opens the comparison) | Discard                       |

- **Preview** shows the image exactly as diners will: the square menu-card crop _and_ the 4:3
  dish-page crop, with the AI label when it applies.
- **Remove** asks for confirmation and returns the dish to `NO_IMAGE`. The file is kept for the
  retention period.
- Every AI-generated image keeps a persistent nudge in the panel: "Temporary image — replace it
  with a real photo when you have one."

## 5. AI image generation

This is a narrow, dish-specific pipeline, **not a general-purpose image generator**. There's no
free-text prompt box.

**Inputs.** The inputs are read from the database at request time, never taken from the client:

- the dish name and description;
- ingredient names (`menu_item_ingredients` → `ingredients`), if any;
- the category name;
- the restaurant name and description, **only** as setting context.

**Prompt construction** is a pure, unit-tested function (no `server-only`, per the
extract-the-core convention), e.g. `buildDishImagePrompt(input) → { prompt, inputHash }`:

- It states only facts present in the input: "Masala Dosa, described by the restaurant as '…'.
  Listed ingredients: …".
- It adds fixed constraints:
  - no text, labels, logos, hands, people or tableware brands;
  - a neutral background;
  - **do not add garnishes, sides or ingredients that aren't listed**;
  - a single serving.
- It never adds claims about the dish (cuisine, spice, portion size, "authentic", "homemade") that
  aren't in the data.
- It's **versioned** (`prompt_version`), so images can be traced to the template that made them.
- Owner-written text (the description) is bounded in length and passed as quoted data, not as
  instructions. That's the same "content is data" rule the waiter's system prompt follows.

**Known limitation, stated plainly:** an image model can still draw things the prompt didn't ask
for. That's why review (§5) and the diner label (§6) are mandatory, not optional polish.

**Review before anything goes live.** A generated image lands in a **private** drafts bucket as
`pending_review`. The owner sees it in the §4 preview and chooses:

- **Use this image** (publishes it);
- **Regenerate** (a new draft, which counts against the cap); or
- **Discard**.

There's no path from generation to the diner menu that skips an owner click.

**Where generation runs:**

- A server action per dish: authorize, check the caps, create a `generating` row, call the model
  (with a timeout), then store the result and mark the row `pending_review` (or `failed`).
- There's no job queue in this project, so bulk generation (§8) is driven by the client: one
  request per dish at a concurrency of 2. Progress lives in DB rows, so closing the tab loses
  nothing.
- A `generating` row older than the timeout is treated as `failed` the next time it's read.

**Provider.** This needs a new, separately configured model list (`MENU_IMAGE_MODEL`, like
`MENU_IMPORT_VISION_MODEL`). It's off unless configured, so the "Generate with AI" button only
appears when generation is actually available (the same pattern as `isAiConfigured()`). Which
model to use, and paying for it, is decision §18.1.

## 6. Diner disclosure

AI-generated images are always labelled where they're shown. The label is never hidden in a
tooltip.

| Surface             | Treatment                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Menu card thumbnail | A small chip over the bottom-left of the image: sparkle icon + **"AI-generated"** in `type-overline`, on a translucent dark backing for contrast on any image |
| Dish page hero      | The same chip, plus a line under the image: "AI-generated image — the dish may look different when served."                                                   |
| Waiter dish cards   | The same chip on the thumbnail                                                                                                                                |
| Image `alt` text    | AI: "AI-generated illustration of {dish}". Real: "Photo of {dish}".                                                                                           |

- Real photos get **no** label.
- `NO_IMAGE` keeps the current intentional text-first layout. No placeholder art.
- The label reads the stored `image_source`, never the URL.
- The AI waiter doesn't see images and never describes a dish's appearance from one. Nothing
  changes in the chat prompt.

## 7. Replacement workflow

```text
Paneer Tikka
✨ AI-generated image                       [ Replace with real photo ]

→ owner picks a file → it uploads and is processed in the background →

┌────────── CURRENT ──────────┐   ┌──────────── NEW ────────────┐
│ [image]                     │   │ [image]                     │
│ ✨ AI-generated image        │   │ 📷 Restaurant photo          │
└─────────────────────────────┘   └─────────────────────────────┘
      (both shown in the square card crop and the 4:3 dish-page crop)

[ Cancel ]                                            [ Replace photo ]
```

- **Replace photo** is enabled only once the new image has reached `pending_review`, meaning its
  variants are stored and it has passed validation.
- **Replace photo** calls `publish_menu_item_image()`. **Cancel** marks the new row `rejected`.
  Either way, the current image never changes until the swap commits.
- The same comparison is used for real → real replacement and for reviewing an AI regeneration.

## 8. Bulk onboarding: "Add photos to your menu"

This is a new page, `/dashboard/menu/photos`. Every figure is a count of real rows:

```text
153 dishes · 12 with a restaurant photo · 30 AI-generated · 111 with no photo

[ Missing photos (111) ] [ AI-generated (30) ] [ All ]        Select: [ All missing ] [ None ]

☐ Masala Dosa   ☐ Plain Dosa   ☐ Sev Khaman …   (grid, each with its current state)

Selected: 12   [ Upload photos… ]   [ Generate 12 with AI ]   (the cap, e.g. "18 left today", shown here)
```

**Flow:** select dishes → **Generate** → a progress grid (per-dish status) → **Review**. Each draft
has **Accept** / **Regenerate** / **Reject**, and there's a "Publish accepted (n)" button.

- **Nothing is generated without selecting dishes and confirming a count.** There's no
  "generate everything" default.
- **Nothing is published without an accept per dish.** Accepting is per image. "Publish accepted"
  runs `publish_menu_item_image()` for each accepted image, and each publish is independently
  atomic.
- **Bulk upload** matches files to dishes by the owner's choice in a grid. It never matches by
  filename automatically, but it can suggest matches for the owner to confirm.

## 9. Trust and the data model

### New table `menu_item_images`

Uses text + `check` constraints, the codebase convention.

| Column                                  | Type                                 | Notes                                                                                                              |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `id`                                    | uuid pk                              |                                                                                                                    |
| `restaurant_id`                         | uuid not null → restaurants, cascade | Tenant key, used by RLS and storage paths                                                                          |
| `menu_item_id`                          | uuid not null → menu_items, cascade  |                                                                                                                    |
| `source`                                | text                                 | `real` \| `ai_generated` \| `unverified`                                                                           |
| `status`                                | text                                 | `uploading` \| `generating` \| `pending_review` \| `active` \| `superseded` \| `rejected` \| `removed` \| `failed` |
| `original_path`                         | text                                 | Private drafts bucket                                                                                              |
| `variant_paths`                         | jsonb                                | `{ "card": …, "detail": …, "detail_2x": … }` in the public bucket, set when processed                              |
| `width`, `height`, `bytes`, `mime_type` | int / int / int / text               | Of the processed original                                                                                          |
| `content_sha256`                        | text                                 | Duplicate detection and integrity                                                                                  |
| `generation`                            | jsonb, null unless `ai_generated`    | `{ provider, model, prompt_version, prompt, input_hash, latency_ms }`                                              |
| `error`                                 | text                                 | Customer-safe, only when `failed` (a check constraint, like `menu_imports`)                                        |
| `created_by`                            | uuid → auth.users, set null          |                                                                                                                    |
| `created_at`, `updated_at`              | timestamptz                          | `set_updated_at` trigger                                                                                           |
| `published_at`, `superseded_at`         | timestamptz                          | Lifecycle audit                                                                                                    |

**Constraints:**

- A unique partial index gives **one `active` row per dish**, and another gives **one `generating`
  row per dish** (so a double-click can't cost two generations).
- `unique (id, menu_item_id)`, which lets `menu_items` reference it with a composite key.
- `generation is not null` if and only if `source = 'ai_generated'`.

### Changes to `menu_items`

These columns are **denormalised on purpose** so the diner menu query needs no join:

- `active_image_id uuid`, with a composite FK `(active_image_id, id) → menu_item_images (id,
menu_item_id)`. The active image must belong to this dish.
- `image_source text` (`real` \| `ai_generated` \| null).
- `image_variants jsonb` (the public variant paths).
- A check: `active_image_id`, `image_source` and `image_variants` are all null or all set.

### Preventing spoofing

`revoke update (active_image_id, image_source, image_variants) on public.menu_items from
authenticated`. The ordinary menu edit path cannot relabel an AI image as a restaurant photo. Only
`publish_menu_item_image()` and `remove_menu_item_image()` (`SECURITY DEFINER`, with an explicit
`is_restaurant_manager_or_owner` check) can write them. This follows the lesson recorded in the
menu-import migration: guards written as `if not …` rely on the coalesce fix.

### RLS on `menu_item_images`

- Members can read.
- Managers and owners can insert and update, and only while the status isn't `active` or
  `superseded`; publishing goes through the function.
- There's no public or diner access at all. Diners only ever read the denormalised `menu_items`
  columns and the public variant files.

### Tenant isolation in storage

- Every object path starts with `{restaurant_id}/`, and bucket policies reuse the
  `(storage.foldername(name))[1]` + `is_restaurant_manager_or_owner()` pattern.
- The publish function also checks that the image's `restaurant_id` matches the dish's and the
  caller's.

## 10. Storage

Everything stays on Supabase Storage; no new provider.

| Bucket                    | Visibility                                  | Contents                                                             | Why                                                                                               |
| ------------------------- | ------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `menu-photo-drafts` (new) | **Private**, signed URLs for the owner only | Uploaded originals; unreviewed AI output                             | Originals can carry EXIF (including GPS). Unaccepted AI images must never be reachable by diners. |
| `menu-photos` (new)       | **Public read**, restricted writes          | Processed variants of images that have been, or are being, published | Diners are anonymous. Signed URLs would expire and defeat caching.                                |

**Paths:** `menu-photos/{restaurant_id}/{menu_item_id}/{image_id}/{card|detail|detail_2x}.webp`.

- The image id is a random UUID, so paths aren't guessable.
- Paths are **immutable** (a new image means a new id), so objects are served with
  `cache-control: public, max-age=31536000, immutable`. Replacing a photo never serves a stale
  cached one.

**Variants:** generated once at processing time. Delivery needs no runtime image optimizer, so
there's no Vercel image-optimization quota and no Supabase transformation plan requirement.

| Variant     | Shape            | Size                  | Used by                                                              |
| ----------- | ---------------- | --------------------- | -------------------------------------------------------------------- |
| `card`      | 1:1, centre-crop | 400 × 400 WebP (q≈75) | Menu cards (96–112 px, 2–3× density), waiter cards, owner thumbnails |
| `detail`    | 4:3, centre-crop | 800 × 600 WebP        | Dish page on phones                                                  |
| `detail_2x` | 4:3              | 1600 × 1200 WebP      | Dish page on high-density and wide screens                           |

- The original is kept private for re-processing (for example, a future focal-point crop). It's
  never served to diners.
- **Server-side processing** (decode, re-encode, resize, strip metadata) needs `sharp` as an
  explicit dependency (§18.2). The browser also downscales uploads to at most 2048 px on the long
  edge before sending, to cut upload time on phones. That's a convenience, never the validation
  boundary.
- **Backups:** Storage isn't covered by `db:backup` today (§18.9).

## 11. Image validation

| Layer             | Check                                                                                                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser           | Types jpeg/png/webp only; ≤ 10 MB (matching `menu-imports`); decodable; shortest side ≥ 600 px; show the §4 preview before uploading                                                                                                                                                                               |
| Storage bucket    | `file_size_limit` and `allowed_mime_types` on the bucket, enforced by Storage itself                                                                                                                                                                                                                               |
| Signed upload URL | Issued by a server action **after** authorization, for exactly one pre-created path (`{restaurant}/{item}/{image}/original`), short-lived                                                                                                                                                                          |
| Server processing | Magic-byte sniff (the declared MIME type isn't trusted). Decode with `sharp` and a pixel limit (decompression-bomb guard). Reject SVG, animated images and anything that doesn't decode. **Re-encode everything**: only re-encoded variants are ever served, so embedded payloads and EXIF/GPS never reach diners. |
| Aspect ratio      | Any ratio is accepted. The centre crops are previewed before publishing, so the owner sees the real result. Focal-point cropping is a later enhancement.                                                                                                                                                           |
| Failure           | The row becomes `failed` with a friendly reason ("This file isn't a photo we can read — try a JPEG or PNG."). The active image is untouched. The owner can retry. Orphaned uploads are removed by the cleanup step (§18.7).                                                                                        |

## 12. AI image safety and trust

- **Never presented as a photograph of the food.** The label is always shown (§6). The dish-page
  caption says the dish "may look different when served". The alt text says "AI-generated
  illustration". The owner UI calls it a "temporary image".
- **Style (§18.6):** I recommend a consistent, lightly stylised "illustrative food" look over a
  photo-real look. That reduces the chance a diner reads it as a real photo even before seeing the
  label.
- **Owner confirmation is required** for every AI image that goes live, and for every replacement.
- **Honest inputs only.** The prompt uses stored menu data (§5). The model is told not to add
  ingredients, and the owner reviews the result.
- **Provider moderation:** use the provider's own safety filtering. A refused generation is
  `failed` and isn't retried automatically.
- **Allergen safety isn't affected.** Images never carry allergen information. Allergens remain
  text, stated "as listed by the restaurant".

## 13. Analytics

There's no product-analytics service, so these follow the existing pattern: **structured JSON log
lines** from a small `server-only` logger (for example `src/lib/menu-photos/logging.ts`, shaped like
`src/lib/ai/logging.ts`).

- Fields: event, restaurant id, dish id, image id, source, latency, model. No image content, no
  prompts containing owner text beyond the stored row.
- Events: `photo_upload_started`, `photo_upload_completed`, `photo_upload_failed`,
  `ai_generation_started`, `ai_generation_completed`, `ai_generation_failed`,
  `ai_generation_accepted`, `ai_generation_rejected`, `photo_published`, `photo_removed`,
  `ai_photo_replaced_by_real_photo`.
- Most product questions ("how many AI images get replaced by real ones, and how fast?") can be
  answered **from the table itself** (source, status, `published_at`, `superseded_at`) without any
  event pipeline. The log lines are for operations: latency and failures.

## 14. Performance

- **No join and no extra queries on the diner menu.** Image data is denormalised onto `menu_items`
  (§9), so the menu query just selects two more columns.
- Cards use the 400 px `card` variant, typically tens of KB as WebP. `loading="lazy"`,
  `decoding="async"` and explicit `width`/`height` (no layout shift) are already in the redesigned
  card. Only dishes near the viewport load.
- The dish page uses `srcset` `detail 800w, detail_2x 1600w`, `sizes="(min-width: 672px) 672px,
100vw"`, with `fetchpriority="high"` on the hero only.
- Immutable URLs with year-long caching (§10), served from Supabase Storage's CDN-backed public
  endpoint.
- Owner pages use the `card` variant for thumbnails. Originals are never loaded in lists.
- **Budget to verify:** first menu screen ≤ 6 image requests and ≤ 300 KB of images on a phone.

## 15. Cost control

| Control                  | Mechanism                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner confirmation       | Every generation is an explicit click. Bulk generation shows "Generate N" with N stated.                                                                                                                                                                              |
| Per-restaurant daily cap | Count `menu_item_images` rows with `source = 'ai_generated'` created in the last 24 h (row-counting, like `rate-limit-core.ts`). Shown in the UI as "n left today". The number is §18.4.                                                                              |
| Per-dish cap             | Maximum regenerations per dish per day, so a single dish can't burn the budget                                                                                                                                                                                        |
| Duplicate prevention     | The one-`generating`-per-dish unique index stops double-clicks. The same `input_hash` for the same dish within a window returns the existing draft instead of paying again.                                                                                           |
| Retries                  | At most one automatic retry, and only for transient provider errors (timeouts, 5xx). No retry on refusals or bad input. The failed row records why.                                                                                                                   |
| Kill switch              | Generation is only offered when `MENU_IMAGE_MODEL` is configured. Unsetting it disables the feature.                                                                                                                                                                  |
| Usage tracking           | The table is the ledger: generations per restaurant, per day, per model, with latency. **Charging for generation or plan-based limits is a future dependency.** The project has plans (`platform_plans`) but no usage metering, and this plan doesn't invent pricing. |

## 16. Product principle, applied

Every surface pushes toward real photos without blocking launch:

- AI images carry a permanent "replace with real photo" call to action in the owner UI.
- The dashboard reports "n AI-generated images you could replace".
- The replacement flow is the shortest path in the photo panel.
- Nothing ever ranks, promotes or prefers an AI image over a real one.

## 17. Implementation plan

Each phase ships behind the previous one and is independently testable.

### Phase 1 — Data model

- **Database:**
  - `menu_item_images` table, constraints and indexes (§9);
  - the three new columns on `menu_items`, with their check and composite FK;
  - the column-level `revoke`;
  - `publish_menu_item_image()` and `remove_menu_item_image()` (`SECURITY DEFINER`, `plpgsql`,
    explicit manager/owner check, `revoke … from public; grant … to authenticated`).
- **Backend:** regenerate `database.types.ts`.
- **Frontend:** none.
- **Storage:** none.
- **Security:** RLS on the new table; column revoke; the functions verify tenant and dish.
- **Testing:** PGlite integration tests:
  - cross-tenant publish denied;
  - an outsider denied (the coalesce lesson);
  - spoofing `image_source` via a plain update denied;
  - one-active and one-generating uniqueness;
  - the composite FK rejects another dish's image;
  - a publish swap is atomic (the old row is superseded only when the new row is active).

### Phase 2 — Storage

- **Storage:** create the `menu-photos` (public) and `menu-photo-drafts` (private) buckets with
  size and MIME limits, and `storage.objects` policies scoped by the restaurant folder.
- **Backend:** add `sharp` (after approval); a pure `imageVariantsPlan()` (sizes and crops) plus a
  server-only processor.
- **Security:** path conventions; drafts never public; cache headers.
- **Testing:**
  - storage-policy integration tests on the existing `storage` stub (`src/lib/backup/supabase-stub.ts`);
  - processor unit tests with fixture images: a valid JPEG, a PNG with alpha, a renamed non-image,
    an oversized image, an EXIF/GPS image (verifying it's stripped).

### Phase 3 — Owner upload

- **Frontend:** the dish photo panel (§4) with browser downscale, preview and progress; the menu
  list thumbnails, badges and filters.
- **Backend:** a server action to authorize, create an `uploading` row and issue a signed upload
  URL; a server action to finalize (validate, process, mark `pending_review`); publish through the
  Phase 1 function.
- **Storage:** original → drafts; variants → public.
- **Security:** a signed URL per image; server-side validation (§11).
- **Testing:** unit (client validation helpers); integration (the finalize path, failure leaving
  the active image intact); a manual pass on iOS and Android photo pickers.

### Phase 4 — AI generation

- **Backend:**
  - `buildDishImagePrompt()` (pure, versioned, unit-tested);
  - the `MENU_IMAGE_MODEL` config and provider client (after approval);
  - a generation server action with caps, duplicate checks, timeout, a single retry and logging.
- **Storage:** results go to drafts.
- **Frontend:** "Generate with AI" and the progress state in the dish panel.
- **Security:** only manager/owner can generate; prompt inputs come from the DB, never the client.
- **Testing:**
  - prompt builder: only the given fields appear; no ingredient is added; owner text is quoted and
    bounded;
  - caps and duplicate prevention (row counting);
  - a mocked provider for success, timeout, refusal and 5xx.

### Phase 5 — Review and publish

- **Frontend:** the comparison view (§7), used for new drafts, regenerations and replacements, with
  both crops and the label preview.
- **Backend:** accept → publish; reject → `rejected`; discard.
- **Testing:** integration: reject leaves state unchanged; accepting a stale draft (the dish changed
  since) is refused; double-accept is idempotent.

### Phase 6 — Diner disclosure

- **Frontend:** `srcset` on the menu card, dish page and waiter cards; the AI chip and caption;
  alt text by source.
- **Backend:** the menu page, dish page and `recommendation-cards.ts` select `image_source` and
  `image_variants`.
- **Security:** the label reads only the stored source.
- **Testing:**
  - component tests: the label always renders for `ai_generated`, never for `real`, and nothing
    renders for no image;
  - an accessibility check of the chip's contrast on light and dark images;
  - a visual pass at 320, 375 and 1366 px.

### Phase 7 — Replacement workflow

- **Frontend:** "Replace with real photo" as the primary action on AI images; real → real replace;
  remove with confirmation; undo within the retention window.
- **Backend:** undo = re-publish a superseded row; a cleanup script for expired superseded,
  rejected and failed files (manual `npm run` script until scheduling exists, §18.7).
- **Testing:** integration: replace keeps the old row until publish; undo restores; cleanup never
  touches `active` rows.

### Phase 8 — Onboarding integration

- **Frontend:**
  - the "Bring your menu to life" step after import commit;
  - the setup-checklist item on the overview;
  - the `/dashboard/menu/photos` bulk page (§8): counts, select, generate queue, review grid,
    publish accepted;
  - the "n AI images you could replace" nudge.
- **Backend:** a counts query; the bulk queue reuses the Phase 4 and 5 actions (no new endpoint
  semantics).
- **Testing:** an E2E test on the disposable project (not production): select 3 → generate (mocked
  provider) → accept 2 / reject 1 → publish → the diner menu shows 2 labelled images.

### Phase 9 — Testing (cross-cutting)

- **Unit:** prompt builder, validation, variant plan, state helpers.
- **Integration (PGlite):** RLS, storage policies, publish, remove, caps, spoofing.
- **E2E:** the disposable Supabase project only. The existing E2E suite writes to production,
  which is an open audit item.
- **Manual:** real phone uploads (large HEIC-origin JPEGs from iOS, Android camera), slow-network
  upload failure, and the diner menu on a throttled connection against the §14 budget.

### Phase 10 — Migration and backward compatibility

- New columns are nullable. Nothing changes for dishes without images.
- **Existing `image_url` values** are URLs owners typed in. How to classify them is decision §18.5.
  The recommendation: migrate each into a `menu_item_images` row with `source = 'real'` **only after
  the owner confirms it's their photo**, and until then keep rendering it as today.
- **Rendering order during the transition:** `image_variants` if present, otherwise legacy
  `image_url`, otherwise text-only.
- Remove the free-text image URL field from the dish form once uploads ship, so no new unlabelled
  images can enter.
- Recount affected rows in production immediately before migrating (0 on Nashta today).

## 18. Decisions (approved 2026-09-19)

These replace the open questions of the first draft. The overriding constraint for this phase:
**AI image generation must cost $0**. There's no paid model, no paid fallback, no credits, no
billing, and never an automatic switch to another model.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Provider:** OpenRouter. **Initial model:** `recraft/recraft-v3:free`, set through configuration (an env var such as `MENU_IMAGE_MODEL`), never hard-coded in more than one place. The rest of the system depends on an `ImageGenerationProvider` interface. The first and only implementation is `OpenRouterImageGenerationProvider`. OpenAI and paid OpenRouter models are _future_ implementations, not built now. If the model is unavailable, rate-limited, deprecated or can't do the job, the feature **fails gracefully**: the owner sees "AI image generation is temporarily unavailable.", nothing switches model, and uploads and everything else keep working. |
| 2   | **`sharp`: yes.** Used for validation (type, dimensions), EXIF and GPS stripping, resizing, compression and the published derivatives. Uploads stay **browser → Supabase Storage direct**, never through a server-action payload (1 MB limit).                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 3   | **Storage: yes.** A **private** area for uploaded originals, pending AI images, and rejected and replaced images during retention. A **published** area for approved images and their optimised derivatives, publicly readable at unguessable paths. Unreviewed AI images are never publicly reachable. Storage internals aren't exposed to the client beyond the final public URLs.                                                                                                                                                                                                                                                                                        |
| 4   | **Limits:** 10 AI generation **attempts** per restaurant per day, 2 per dish per day, and at most 1 pending generated image per dish. **Enforced in the database, counting attempts, not successes.** Configurable. No plan-dependent limits, billing, usage charging or Stripe.                                                                                                                                                                                                                                                                                                                                                                                            |
| 5   | **Existing image URLs** are **not** treated as real photography. They become `unverified` until an owner or manager explicitly confirms them, which converts them to `real`. They're never deleted by the migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 6   | **Style: illustrative, not photo-real.** Premium, appetising, tasteful, editorial, and clearly an illustration. Every approved AI image shows **"AI-generated"** on menu cards, dish pages and waiter cards. Alt text: **"AI-generated illustration"**. The dish page adds **"AI-generated illustration. The dish may look different when served."** Real photos carry no label.                                                                                                                                                                                                                                                                                            |
| 7   | **Retention:** rejected and replaced images are kept **30 days**, then become eligible for deletion by a **manual/admin cleanup script**. There's no job infrastructure and no automated lifecycle. The active image is never deleted before its replacement is uploaded, processed and activated.                                                                                                                                                                                                                                                                                                                                                                          |
| 8   | **Permissions:** only **owners and managers** can upload, generate, review, approve, reject, replace, or confirm an existing image as authentic. Diners are read-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9   | **Storage backups: not in this phase.** This is recorded as an infrastructure gap. Records, object paths, versions and source metadata are structured so a future export can walk them without a redesign (every object path is derivable from a `menu_item_images` row).                                                                                                                                                                                                                                                                                                                                                                                                   |

### Provider finding (checked 2026-09-19)

Checked against OpenRouter's public API:

- `GET https://openrouter.ai/api/v1/models/recraft/recraft-v3:free/endpoints` returns the model
  (text+image → image, about 1K resolution) with **`"endpoints": []`**: no provider is currently
  serving the free variant.
- It doesn't appear in `GET /api/v1/models` at all.
- None of the 11 image-output models listed there is free.

**As of today, the chosen free model can't produce an image.** This is exactly the case decision 1
covers: Phase 4 must detect it (no endpoints, a 404/unavailable error, or a rate limit) and show
"AI image generation is temporarily unavailable." It must never try another model. Everything else
(real uploads, review, publishing, diner labels) doesn't depend on it.

Before Phase 4, re-check the endpoint. If it's still empty, the zero-cost AI path can't be tested
end to end. Choosing any alternative is a new decision, because every current image-output model
is paid.

## 19. Phase 1 as built

Migration `supabase/migrations/20260919100000_menu_item_images.sql`, tests
`tests/integration/db/menu-item-images.test.ts` (34 tests; full suite 1,429 passing).

**Built:**

- **`menu_item_images`** as §9, with these differences from the sketch:
  - `source` has a third value, **`unverified`**, for legacy URLs (§18.5).
  - The `processing` status was dropped: the server processes an upload between `uploading` and
    `pending_review`, and a separate state added nothing.
  - `external_url` holds legacy URLs.
  - `status_changed_at` (maintained by a trigger) drives the 30-day retention.
  - `confirmed_by`/`confirmed_at` record who vouched for a legacy image.
- **`menu_items`** gains `active_image_id`, `image_source` and `image_variants`, with a composite
  FK so the active image must belong to the same dish, and `ON DELETE SET NULL (active_image_id)`.
- **Anti-spoofing is a trigger, not a column `REVOKE`.** On Supabase, `authenticated` holds a
  table-wide `UPDATE` grant, which a column-level revoke doesn't override. So
  `menu_items_guard_image_columns()` refuses any direct write to the three image columns from the
  `authenticated`/`anon` roles. The image functions, running as their owner, pass. The image table
  itself has **no write policies**: owners can read their rows but never write them directly.
- **Limits in the database:** a single-row `menu_image_generation_limits` table (10 / 2 / 1, plus
  a 180 s generation timeout), readable by signed-in users and changed only by migration or
  service role. `begin_menu_item_image_generation()`:
  - locks the restaurant row, so concurrent requests can't both take the last attempt;
  - expires stale `generating` rows (they still count as attempts);
  - counts rolling-24-hour **attempts** (any outcome) per restaurant and per dish;
  - refuses a second pending image per dish, backed by a unique index on `generating`.
- **Functions** (all `SECURITY DEFINER`, `plpgsql`, owner/manager check via the coalesce-safe
  `is_restaurant_manager_or_owner`):
  - `begin_menu_item_image_upload`
  - `begin_menu_item_image_generation`
  - `complete_menu_item_image` (paths must sit under `{restaurant}/{dish}/{image}/`; AI requires
    provider and model metadata; a real photo refuses it)
  - `fail_menu_item_image`
  - `publish_menu_item_image` (the only route to diners; an atomic swap)
  - `reject_menu_item_image`
  - `remove_menu_item_image`
  - `confirm_menu_item_image_authentic` (`unverified` → `real` only; refuses AI images)
  - `get_menu_image_generation_quota` (for the owner UI)
  - `backfill_legacy_menu_item_images()` (idempotent, not callable by request roles; run once by
    the migration)

**Verified by tests:** the lifecycle from no image → real, and AI → real; the old image staying
active until publish; failure and rejection leaving the active image untouched; exactly one active
image; path confinement; AI metadata rules; all three limits, including attempt counting,
24-hour expiry, timeout handling and configurability; kitchen, staff, anonymous and cross-tenant
refusals; composite-FK rejection even for the admin; the anti-spoofing trigger (while ordinary menu
edits still work); legacy backfill idempotency and confirmation; and cascade on dish deletion.

**Not done in Phase 1, by design:**

- No storage buckets, `sharp`, provider, server actions or UI.
- `database.types.ts` isn't regenerated. That happens after the migration is pushed, because the
  types are generated from the live schema.
- The diner pages still render the legacy `image_url`. Nothing visible changes yet.

**To deploy:** run `npx supabase db push` (linked to production `dqypmprjcyxoeywsumxr`). The
backfill will convert any existing `image_url` values to `unverified`. Nashta has none.

### Audit fixes (2026-09-19, before first commit)

A read-only audit of the migration found three defects, all fixed in the same (unpushed) migration:

- **B1 — function grants.** Supabase grants EXECUTE on new `public` functions to `anon`,
  `authenticated` and `service_role` through default privileges, not only to `PUBLIC`. The
  internal helpers were revoked from `PUBLIC` only, so on a live project they'd have been callable
  by anyone with the anon key. The worst case was `backfill_legacy_menu_item_images()`: a write
  across every restaurant.
  - Every function is now classified as **public API** (9; revoked from `public`/`anon`, granted
    to `authenticated`, owner/manager check inside) or **internal** (5; revoked from `public`,
    `anon` and `authenticated`).
  - Trigger functions can't be called through the API.
  - The integration harness (`tests/integration/db/setup.ts`) now **mirrors Supabase's default
    function privileges**, so a missing revoke fails a test.
- **B2 — quota bypass by deleting dishes.** Attempts were counted from `menu_item_images`, which
  cascade-delete with the dish. Deleting and re-creating dishes allowed 14 attempts inside the
  10/day limit.
  - Attempts now live in **`menu_image_generation_attempts`**, an append-only ledger.
    `menu_item_id` and `image_id` become `NULL` on delete, but the row stays.
  - A trigger refuses direct deletes (only the restaurant's own deletion cascades), changes to
    identity or timing, and more than one status transition. This applies to every role,
    including the admin.
  - Quotas count from the ledger. A re-created dish starts a fresh per-dish count, but the
    restaurant count never goes down.
  - Attempt outcomes are recorded: succeeded (with provider and model), failed, cancelled, timed
    out.
- **B3 — path traversal.** `original_path` lacked the variants' `..` check. Both now go through
  `menu_image_path_is_valid()`: the path must be the image's own folder plus one plain file name
  (`[A-Za-z0-9_-]+`, optionally one short extension). That rules out `..`, `./`, sub-folders,
  backslashes, empty names and whitespace. Non-string variant values are refused.

### Pre-existing finding outside Phase 1 (fixed separately)

With the harness mirroring Supabase's default function privileges, **57 functions from earlier
migrations were executable by `anon`**. The four webhook-only payment functions
(`mark_order_payment_succeeded`, `mark_order_payment_failed`, `mark_refund_settled`,
`record_restaurant_subscription`) had no caller check, so a diner could have marked their own
Checkout paid.

- **Production:** confirmed exposed, then revoked by hand on 2026-09-19. Read-only checks found no
  sign of abuse.
- **Repository:** fixed by `20260919090000_revoke_anon_from_server_functions.sql` (the commit this
  one builds on). It also covers three signed-in-only functions.
- **Guard:** `tests/integration/db/function-grants.test.ts` pins the 50 functions still callable
  by `anon` as a pending-review list, so a newly exposed function fails CI. Reviewing those 50 is
  follow-up work.
