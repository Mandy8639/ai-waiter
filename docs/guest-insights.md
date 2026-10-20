# Guest insights

The **Guests** page (`/dashboard/guests`, owners and managers) answers who comes, when, how they
use the AI waiter and what they think, over Today, the last 7 days or the last 30 (default).
Money is in Reports; this page is about the guests behind it.

## What it shows

- **Table visits:** every phone that scanned a table code (or ordered for pickup), how many
  ordered, and spend per visit that ordered (cancelled orders aside).
- **AI waiter:** visits that asked it a question, how many of those went on to order, and spend
  per visit with and without it. The "spent X% more" line waits until each side has at least
  three ordering visits, so one big table doesn't read as a trend.
- **Busy times:** orders by weekday and hour in the restaurant's own time zone, the three
  busiest slots, and a shaded grid.
- **Bookings and regulars:** bookings kept, guests seated, no-shows, cancellations, the share of
  guests who had booked before, and the top ten regulars (two or more kept bookings, one of
  them in the period).
- **Ratings:** the 1–5 star spread, linking to Feedback for the comments.

## How it works

- One database call, `get_guest_insights(restaurant, from, to)`
  (`supabase/migrations/20261029090000_guest_insights.sql`), returns everything as one JSON
  document. It is owner/manager only (`assert_can_view_reports`, the same gate as takings) and
  never callable signed out.
- A diner at a table is an anonymous sign-in that lasts one visit, so table visits can't be
  linked to each other. Returning guests and regulars come from reservations only.
- Guests are matched across bookings by the **last nine digits** of their phone, so
  "+44 7700 900001" and "07700 900001" are the same guest. Phone numbers are never returned to
  the page; a regular is shown by the name on their latest booking.
- Arithmetic and wording: `src/lib/guests/insights-core.ts`. The read:
  `src/lib/guests/insights.ts`.

Tests: `tests/unit/guest-insights-core.test.ts`, `tests/integration/db/guest-insights.test.ts`.
