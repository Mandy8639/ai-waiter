# Accessibility

Target: **WCAG 2.2 Level AA** on the customer-facing diner flow — QR landing, menu, item detail,
cart, checkout, order tracking, and the AI chat dialog. Mobile-first, used on whatever phone walks
in.

## Audited 2026-09-04

Findings were measured against the deployed app — real accessibility tree, real keyboard input —
not inferred from markup. Four barriers were found and fixed.

### 1. The AI chat dialog could not be closed by keyboard — SC 2.1.2, 2.4.3

The worst of the four. On the deployed build:

|                                     | Before                                       |
| ----------------------------------- | -------------------------------------------- |
| Focus moves into the dialog on open | ❌ stayed on the trigger                     |
| Focus stays inside while open       | ❌ escaped to background content in two tabs |
| Escape closes it                    | ❌ did nothing, even with focus inside       |
| A close button exists               | ❌ none anywhere in the app                  |

`DialogClose` was exported from `components/ui/dialog.tsx` and **used nowhere**, so no dialog in
the app had a dismiss control. Base UI's own guidance is explicit: _"When `modal` is `true`…
render `<Dialog.Close>` inside `<Dialog.Popup>` so touch screen readers can escape the popup."_

**Root cause** was not the missing button, though. The floating action button was a plain
`<button onClick={() => setOpen(true)}>` rendered _outside_ the `<Dialog>` root — so Base UI never
knew a trigger existed, and none of its focus lifecycle ran. Neither `initialFocus={true}` nor a
ref fixed it, because the library had nothing to anchor to.

**Fix:** the button is now a real `DialogTrigger` inside the Dialog root, and `DialogContent`
renders a `DialogClose` for every dialog in the app — placed in the shared component so no future
dialog can forget it. With a registered trigger, Base UI's default behaviour works: focus enters
on open, Escape closes, focus returns to the trigger.

### 2. AI replies were never announced — SC 4.1.3, 1.3.1

The transcript had no `role` and no `aria-live`. The typing indicator _did_ announce "Thinking…",
so a screen reader user was told an answer was coming and then never told it had arrived — worse
than no indicator, because it sets an expectation that never resolves.

Messages were also bare `<div>`s: who said what was carried **only by colour and alignment**.

**Fix:** `role="log"` + `aria-live="polite"` on the transcript, and a visually-hidden "You said:" /
"AI waiter said:" prefix per message. `polite`, not `assertive` — a reply is worth hearing, not
worth interrupting what the user is currently reading.

### 3. Order status changed silently — SC 4.1.3

`OrderStatusSync` renders nothing and drives updates with `router.refresh()`, so the status badge
is replaced by a server re-render. Visually obvious; to a screen reader, silent — on the one screen
a diner sits and watches.

**Fix:** the badge sits in a `role="status"` region with a visually-hidden "Order status: Ready"
sentence. Duplicated deliberately: a live region announces its whole contents, and "Ready" alone is
ambiguous where "Order status: Ready" is not.

### 4. The menu page had no headings at all — SC 1.3.1, 2.4.6

`headings: []` on the busiest screen in the app. Screen reader users navigate primarily by heading.
Every other page in the flow had one; the menu was the only gap.

**Fix:** a visually-hidden `<h1>{restaurant} menu</h1>` — hidden because the restaurant name is
already visible in the header and a second copy would be redundant clutter — plus
`<nav aria-label="Menu categories">` around the category strip so it can be skipped or jumped to.

## What already passed

Stated because an audit that only lists failures is hard to trust:

- **Target sizes meet SC 2.5.8.** Quantity buttons are 28px (minimum is 24). Modifier checkboxes
  render at 16px but sit inside a padded `<label>`, so the whole row is the target, not the box.
- `lang="en"`, descriptive `<title>` per page, `header`/`main` landmarks.
- Form errors and the "Added to cart" confirmation already used `role="alert"`.
- Icon-only buttons are labelled; decorative icons are `aria-hidden="true"`.
- Animations are behind `motion-safe:`, respecting reduced-motion preferences.

## Regression protection

`tests/e2e/a11y-diner-flow.spec.ts` asserts these through **real keyboard interaction** — Enter to
open, focus lands inside, Escape closes, the close button works — rather than by inspecting
markup. Driven by Playwright because ad-hoc browser automation proved unreliable for focus and key
events while this was being fixed, and a test that is flaky about focus is worse than no test: it
teaches you to ignore it.

## Not yet covered

Honest scope. This pass covered the diner flow only, and not everything within it:

- **Colour contrast was not measured.** No computed-contrast pass was run over the palette; the
  4.5:1 / 3:1 ratios are unverified.
- **No real screen reader was used.** Findings are from the accessibility tree and keyboard
  behaviour. VoiceOver and TalkBack have their own quirks, and nothing here has been heard out loud.
- **The staff and kitchen surfaces were not audited at all** — dashboard, kitchen display, reports.
  They are used for a whole shift, which arguably makes them more demanding than the diner flow.
- **Zoom and reflow to 400% (SC 1.4.10)** was not tested.
