# UI spec

Uses the existing design system (`docs/DESIGN_SYSTEM.md`) and dashboard shell. No Clover screens
were viewed or copied. These are Tableside designs.

## Floor (service view): `/dashboard/floor`

- **Nav:** new "Floor" item, visible to all roles, added to the nav-items roles list and
  `access-core` (new pages need a roles entry).
- **Layout:** section tabs across the top, the grid in the middle, and a side panel on the right
  for the selected table (a bottom sheet under 768px).
- **Table tile:** the shape at its size and rotation. Inside: the table number (large), the state
  label, the time in state ("12 min"), and the unpaid amount when there is one.
- **State colors:** each state has a token _and_ an icon _and_ a label, so color is never the
  only signal (`docs/accessibility.md`). The three states that need action (wants the bill, needs
  a waiter, ready to serve) get a pulsing outline, with motion turned off under
  `prefers-reduced-motion`.
- **Legend:** a collapsible key listing every state.
- **Side panel:** the orders with their statuses, an open request with **Resolve**, **Settle up
  this table** (the existing cash and card-machine actions, filtered to the table), and **Start
  table bill** (F2).
- **Tray:** a strip of unplaced tables, with live states, below the grid.
- **Phone:** under 640px the grid becomes a list sorted by urgency (states 1–3 first). A pinch
  grid on a phone mid-service is a trap.
- **Keyboard and screen reader:** each tile is a button named "Table 4, wants the bill, 12
  minutes, $44.75 unpaid". Arrow keys move between tiles in reading order (top-left to
  bottom-right).

## Floor plan editor: `/dashboard/tables/floor-plan`

- Owners and managers only.
- Toolbar: add section, add landmark, snap to grid (on by default), undo.
- Drag tables from the tray onto the grid. The handles resize and rotate in 90° steps. Seats are
  set in an inspector panel.
- An overlap shows a red outline and disables Save. The message names the two tables.
- **Keyboard alternative to dragging:** pick a table, then use arrow keys to move it one cell
  (Shift for five), R to rotate. Dragging alone fails WCAG 2.2 SC 2.5.7.
- **Empty state:** "Place your tables to see the room live during service." with a button that
  lays out all tables in rows to start from.

## Table bill (diner): inside `/r/[restaurantSlug]/...` bill screen

- A new secondary button under the existing pay options: **Pay for the table**. It's shown only
  when another phone at the table has unpaid orders.
- **Preview:** grouped cards ("You", "Guest 2", …) with lines and subtotals, and a sticky table
  total. Then **Pay all** (primary) and **Split** (opens the existing split chooser).
- **Other phones** get a banner: "Someone at your table is paying the bill." Their pay buttons
  are disabled, with the reason given in text.
- **Done:** every phone's receipt reads "Paid by your table".

## Copy rules

- Never show another guest's name, phone or anything that identifies them. Only "Guest 2" etc.
- Money always formatted by the existing `src/lib/format` helpers, in the order's currency.
