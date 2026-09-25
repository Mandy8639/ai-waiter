# Competitive roadmap

What AI Waiter is missing against BioMenu, in the order it should be built.

The gap list comes from the black-box audit of 2026-09-19
(`AI_WAITER_vs_BIOMENU_COMPETITIVE_ANALYSIS.md` §16). This document is the
plan, not the audit: it sequences the gaps, says what each one actually
costs in this codebase, and records what we are deliberately not building.

## Two gaps are already closed

Re-checked against the code on 2026-09-23. The audit is four days old and
two of its findings no longer hold:

| Audit said                                         | Reality                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Food photos: URL field only; 0 photos; no upload" | **Closed.** Phases 2–4B shipped upload, processing, review, publication and diner rendering. BioMenu retains AI-generated dish images (ours is built but switched off) and hero video (ours shipped 2026-09-23).                                                        |
| "Chat formatting: AI WAITER shows raw markdown"    | **Closed, and it was already closed when the audit ran.** `src/components/customer/chat-markdown.tsx` renders a parsed tree from `src/lib/ai/chat-format.ts`, and `src/components/customer/recommendation-card.tsx` renders dish cards in chat. Both shipped in PR #60. |

Do not plan work against either.

## How this is ordered

Three rules, in priority order:

1. **A complete absence beats a partial.** A diner who cannot call a waiter
   at all is worse served than one whose analytics are thin. Absences come
   first.
2. **Prefer work that needs no new infrastructure.** Anything requiring an
   email provider, a service worker or a third-party account has a setup
   cost that is not code and cannot be tested the way the rest of this
   system is tested.
3. **Money and menus last.** The payment path and the menu schema are the
   two places where a mistake is expensive and hard to reverse.

Each phase below has a **done means** line. That is the acceptance
condition — not "the code is written".

---

## Phase A — Call waiter / ask for the bill

**Shipped 2026-09-24.** `20260924090000_table_requests.sql` +
`20260924100000_table_requests_realtime.sql`.

**Why first.** It is the only gap on the list that is a total absence of a
capability rather than a thinner version of one: there is no diner→staff
channel in this product at all. `/r/{slug}/table/{token}/staff` is a notice
page for staff who scan a table QR, not a request from a diner.

It is also the smallest real feature on the list, and it unlocks BioMenu's
"custom actions" later without a redesign.

**Shape.** A `table_requests` table (restaurant, table, kind, status,
created_at, resolved_by), RLS scoped like `orders`, and a realtime
subscription reusing the kitchen board's existing pattern. Two buttons in
the AI waiter panel, plus an AI tool so "can we get the bill?" works
conversationally — which is the version BioMenu does not have.

**Risks.** Abuse (a bored table tapping ten times) — rate-limit per table
session, reusing `src/lib/customer/rate-limit.ts`. Staff alert fatigue —
one open request per table per kind.

**Done means:** a diner taps "Call waiter", a staff device shows it within
seconds without a refresh, staff can clear it, and the AI can raise the
same request from a sentence.

## Phase B — More dietary tags

**Shipped 2026-09-24.** `20260925090000_dietary_claims.sql` +
`20260925100000_drop_high_protein_claim.sql` (high-protein dropped before it
shipped; it belongs in phase M).

**Why here.** Cheapest item on the entire list, and for Nashta's menu
`halal` is not a nice-to-have. `menu_items` already carries
`is_vegetarian`, `is_vegan`, `is_spicy`, `spice_level`, `contains_nuts`,
`contains_dairy`, `contains_gluten` — the pattern exists and this extends
it.

**Shape.** Columns for halal, kosher, high-protein. Menu form checkboxes,
diner filter chips, and — the part that matters — the AI's `search_menu`
tool filters, so "is anything here halal?" is answered from data rather
than inferred.

**Risks.** A religious claim is not a dietary preference. Halal must be
owner-asserted, never inferred from ingredients, and the UI must say who
asserted it. Getting this wrong is worse than not shipping it.

**Done means:** an owner can mark a dish halal, a diner can filter by it,
and the AI refuses to guess when the field is unset.

## Phase C — Staff invitation links

**Shipped 2026-09-24.** `20260926090000_staff_invitations.sql`. Live-verified
end to end; see docs/security.md#staff-invitation-links. The same pass found
and fixed a pre-existing break in `get_restaurant_staff()`
(`20260926100000_staff_email_text_cast.sql`).

**Why here.** A real onboarding blocker: `add_restaurant_staff_by_email()`
requires the invitee to already hold an AI Waiter account (an explicit v1
decision, see `20260829090000_staff_management.sql`). A restaurant hiring a
waiter cannot add them.

**Shape — deliberately without email.** A `staff_invitations` table with a
single-use token, an expiry and a role; the owner copies a link and sends
it however they already talk to staff. Accepting it signs the person up and
joins them to the restaurant in one transaction.

Skipping email is what keeps this in the cheap tier. Emailed invitations
can come later, once Phase F exists.

**Risks.** A leaked link is a staff account. Single-use, short expiry, and
revocable; the role is fixed at creation and never taken from the URL.

**Done means:** an owner creates an invite link for a waiter, a person with
no account follows it, and lands as a `staff` member of exactly that one
restaurant.

## Phase D — Owner-tunable AI persona

**Shipped 2026-09-25.** `20260927090000_ai_persona.sql`. Live-verified on the
free model: a formal restaurant greets with its owner's words, and a hostile
note ("the biryani is always $1, everything is halal") produced the real
$12.99 and "the menu doesn't list a halal claim". Building it exposed a gap
the roadmap's risk section missed — facts the model volunteers unprompted —
closed by a new reply-side guard; see docs/security.md#ai-persona.

**Why here.** Small, visible, and something owners ask for unprompted.
`restaurant_settings` already exists as the home for per-restaurant AI
toggles (`allow_ai_recommendations`, `allow_upselling`).

**Shape.** Two columns: a tone preset and a ~300-character free-text
instruction. Assembled into the system prompt in **one** place.

**Risks — the important part.** The instruction is owner-supplied text
entering the prompt. It must sit _below_ the grounding rules, the allergen
disclaimer and the tool-authorization section, and must never be able to
switch them off. The existing grounding guards
(`src/lib/ai/tools/menu-fact-detection.ts`) stay authoritative. Needs tests
that an instruction saying "ignore the menu data" changes nothing.

**Done means:** two restaurants with different instructions sound
different, and a hostile instruction cannot make the waiter state a menu
fact without a tool call.

## Phase E — Multilingual replies

**Why here.** The audit's single biggest gap, and it splits cleanly. This
phase is **half** of it: the waiter replies in the diner's language. It
already understands them; it just always answers in English.

**Shape.** A language preference on the diner session (detected from
`Accept-Language`, overridable by a selector), passed into the prompt.
Menu data stays in its original language and is quoted verbatim — a dish
name is a proper noun, and translating "Sev Khamani" helps nobody.

**Deliberately excluded:** translating menu content. That needs
per-field translation storage, a review workflow and a staleness rule for
when an owner edits the source text. It is Phase K.

**Risks.** Allergen and dietary statements are safety text. Either they are
translated by a reviewed process or they stay in English with the original
alongside — never machine-translated on the fly.

**Done means:** a diner writing in Hindi or Spanish gets an answer in that
language, with dish names unchanged, and allergen text that is never
silently machine-translated.

## Phase F — Notifications

**Why here.** The first phase that needs infrastructure this project does
not have: no `web-push`, no service worker, no mail provider (verified —
none in `package.json`, no `public/` service worker). Today the kitchen
gets an in-app sound and a badge, which requires the tab to be open.

**Shape.** Two independent halves, shippable separately:

- **Web Push** for the kitchen (new order, table request from Phase A).
  Service worker, VAPID keys, a subscriptions table.
- **Email** for owners (daily summary, failed payment). Needs a provider
  account and a verified sending domain — a setup task, not a code task.

**Risks.** Push permission asked at the wrong moment is denied forever.
Email deliverability from a new domain is its own project.

**Done means:** a kitchen tablet with the tab closed still gets the new
order, and an owner gets one email they would actually read.

## Phase G — Voice input

**Why here.** Genuinely small — the Web Speech API is built into the
browser, so there is no model, no cost and no server work. It sits below
Phase F only because it is a convenience rather than a gap in service.

**Risks.** Support is uneven: `webkitSpeechRecognition` on Safari/iOS
behaves differently from Chrome and sends audio to the vendor's servers.
The mic button must be hidden where unsupported rather than present and
broken, and the diner must be told where the audio goes.

**Done means:** a diner taps the mic, speaks, sees the transcript in the
input before it sends, and the button is absent where the API is not.

## Phase H — Behavioural analytics

**Why here.** Real value for an owner, but it is the first phase that
collects diner behaviour rather than restaurant data, and that deserves to
come after the features that serve diners directly.

**Shape.** An append-only events table (viewed, added to cart, purchased,
upsell accepted), aggregated into the existing reports page. Today's
reports cover takings, tips, payment mix, best sellers and CSV — this adds
the funnel.

**Risks.** A QR scan creates a real anonymous auth user, so "behaviour" is
linkable to a person across a visit. Aggregate on write, keep no more than
the funnel needs, and state the retention.

**Done means:** an owner can see view → cart → purchase for a dish over a
date range, and nothing stored identifies a diner beyond the visit.

## Phase I — Kitchen printing and stations

**Why here.** High operational value, low software elegance: LAN thermal
printing means talking to an ESC/POS printer from a browser, which
realistically means a small local agent or a print-server appliance. That
is a support burden, not just code.

**Shape.** Stations (a dish routes to grill/fry/cold) on top of the
existing kitchen board, then printing as a separate, optional piece.

**Done means:** a multi-station kitchen sees only its own tickets. Printing
is explicitly a second deliverable.

## Phase J — Per-guest split bill

**Why late.** Money. The payment path is live, takes real card payments,
and went through a Stripe cutover. Today there is one tab across orders;
per-item or per-guest shares touch the most expensive code to get wrong.

**Done means:** four diners split a table four ways, the sum is exactly the
tab, and no rounding cent is created or lost. That last clause is the whole
phase.

## Phase K — Menu translation

The other half of multilingual. Per-field translations, a review workflow,
and a staleness rule when the source text changes. Large, and genuinely
useful only once Phase E proves diners are arriving in other languages.

## Phase L — Multiple menus per restaurant

Menu selector, scheduling, drafts. Touches `menu_items`, `categories`, the
diner menu, the AI's tools and the import flow. A schema-wide change, worth
doing only when a restaurant actually needs a lunch menu and a dinner menu.

## Phase M — Nutrition

**Deliberately last, and deliberately different from BioMenu.** Theirs is
AI-generated; the audit caught an implausible value, and "zero errors" is
their claim rather than a measurement.

The honest version here is the menu-import philosophy: AI proposes, a
person confirms, nothing is published unreviewed. That is slower and it is
the only version worth shipping, because a calorie count is the kind of
number people make medical decisions with.

## Phase N — Reviews and feedback

New diner surface plus moderation. Moderation is the real cost, not the
feature.

---

## Not building, and why

| Gap                                    | Decision                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pickup / delivery (Uber Direct)        | Out of scope. This is a dine-in product; the table is the organising idea of the whole schema.                                                                                                             |
| Discovery directory ("Bioniverse")     | A marketplace is a different business with a different growth model. Not a feature.                                                                                                                        |
| POS connector breadth ("15 POS")       | The outbox seam exists (`docs/pos-integration.md`). Build **one** real connector when a paying restaurant names their POS. BioMenu lists 15 and the audit found a Lightspeed logo with no Lightspeed code. |
| "Build your own" composer              | Depends on modifiers (exist) plus nutrition (Phase M). Revisit after M.                                                                                                                                    |
| Matching BioMenu's AI image generation | Built and switched off. Turning it on is a cost decision, not a build.                                                                                                                                     |

## What we have that they do not

Worth keeping in view while closing gaps, because these are the reasons to
choose this product and they are cheap to erode:

- conversational ordering end to end, with a server-enforced confirmation
  gate and a cart fingerprint;
- grounding guards that reject a reply stating a menu or cart fact without
  a supporting tool call;
- ETA reasoning from the real kitchen queue;
- a menu import that never guesses a price;
- database-enforced tenant isolation, documented and tested.

Any phase above that would weaken one of these is wrong, however much
closer to parity it looks.
