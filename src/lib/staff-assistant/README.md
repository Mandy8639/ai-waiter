# The staff assistant

Typed commands for the switches staff flip mid-service: "86 the salmon", "pause ordering for an
hour", "make the mango lassi $5.50". The design (no new write path, the model only classifies, ask
first for prices and anything the model read) is in [`docs/ai.md`](../../../docs/ai.md#staff-assistant-dashboard).

| File              | What it does                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| `actions.ts`      | The two server actions: a typed command, and a button (Yes, Undo, "which one?").               |
| `parse-core.ts`   | The built-in phrases, read without a model.                                                    |
| `interpret*.ts`   | The model's narrow job: one message in, one JSON command out, for what the phrases don't read. |
| `intent.ts`       | The schemas both readings, and every button, are held to.                                      |
| `resolve-core.ts` | Matching "the salmon" to the menu; never guesses between several.                              |
| `plan-core.ts`    | Run, ask first, ask which, answer or refuse; what to say after, and the Undo.                  |
| `execute-core.ts` | Calls the dashboard's own database functions, as the signed-in person.                         |
| `queries.ts`      | Menu and kitchen reads, the rate limit, and the command log (`staff_assistant_commands`).      |

Files without `server-only` are kept that way so they can be unit-tested directly.
