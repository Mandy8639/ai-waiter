# The AI waiter

The conversational ordering layer. The full design — the separation, the tools, grounding, model
fallback, prompt-injection defence — is in [`docs/ai.md`](../../../docs/ai.md); this is a map of
the directory.

The one rule everything here follows: **the model never touches the database and is never the
source of truth.** It chooses among 12 narrow tools, each a thin, Zod-validated wrapper around the
same code the ordinary UI calls, and every fact it states about the menu or the cart must come from
a tool that succeeded in the same turn.

| File                                                | What it does                                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `actions.ts`                                        | The server action the chat UI calls; resolves the customer session and restaurant, then hands off to the orchestrator.                |
| `orchestrator.ts`                                   | One customer turn: config/input/rate-limit checks, server-derived tool context, running the loop, mapping every failure to safe copy. |
| `loop.ts`                                           | The tool-calling loop — pure, no I/O. Enforces the per-turn tool-call ceiling and the one bounded guard retry.                        |
| `tools/`                                            | The 12 tools (`menu.ts`, `cart.ts`, `order.ts`), their schemas, and the registry that validates arguments before anything runs.       |
| `tools/menu-fact-detection.ts`                      | Menu-fact guard: a menu question must be answered from `search_menu` / `get_menu_item` / `get_restaurant_info`.                       |
| `tools/cart-fact-detection.ts`                      | Cart-state guard: a reply stating what the cart holds or costs must follow a successful `get_cart`.                                   |
| `tools/order-confirmation.ts`                       | Server-enforced confirmation gate on `submit_order` (earlier-turn confirmation + cart fingerprint).                                   |
| `providers/`                                        | Anthropic and OpenRouter behind one interface; `text-acceptance-guards.ts` builds the guards once for both.                           |
| `config.ts`                                         | Models and fallback lists, timeouts, tool-call ceiling, history length, input cap, rate limit — all env-overridable.                  |
| `rate-limit.ts`, `rate-limit-core.ts`               | 20 messages per 10 minutes per customer session (not per IP — diners share restaurant Wi-Fi).                                         |
| `system-prompt.ts`, `conversation.ts`, `history.ts` | The prompt, and how past turns are stored and replayed to the model.                                                                  |
| `persona.ts`, `get-persona.ts`                      | The owner's tone preset and style note (phase D): normalisation, and the session-scoped read. Style only — the guards never read it.  |
| `logging.ts`, `provider-error.ts`                   | Structured turn/tool/error logs, and classifying provider failures.                                                                   |

Files without `server-only` (`loop.ts`, `*-core.ts`, the detection modules, provider mappings) are
kept that way on purpose so they can be unit-tested directly.
