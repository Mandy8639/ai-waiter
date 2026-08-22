# AI architecture placeholder

**Nothing in this directory is implemented yet.** No model calls, no tool definitions, no
prompt handling. This file exists only to reserve the location where that code will live,
per [`docs/ai.md`](../../../docs/ai.md).

When the AI waiter is built (a later batch), this directory will hold the validated tool
layer the model calls through — `search_menu`, `get_cart`, `submit_order`, and similar — each
one a thin, typed wrapper around the real business logic in `src/lib/menu/` and
`src/lib/orders/`. The model never queries the database directly; see `docs/ai.md` for the
full separation this is designed around.
