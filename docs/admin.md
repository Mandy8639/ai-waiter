# Admin page

`/admin` is the platform owner's page: settings that apply to every restaurant, changed without
editing Vercel or redeploying. Restaurant owners and staff never see it. The full plan, with the
later phases, is the "Tableside Admin Page — What We're Building" doc.

## Who can open it

- The signed-in email must be listed in the `PLATFORM_ADMIN_EMAILS` Vercel variable
  (comma-separated). Anyone else gets "page not found", the same as a page that doesn't exist.
- Two-step verification must be on for that account, and entered this session (`aal2`). Without
  it, the page asks you to turn it on in `/account`.
- `src/lib/admin/access.ts` (`requirePlatformAdmin()`) checks both on the server for every page
  view. The sidebar's **Admin** link (`isPlatformAdmin()`) is presentation only.

## AI models

Five AI jobs, each with its own model list:

| Job               | Vercel variable            | Free only |
| ----------------- | -------------------------- | --------- |
| Diner's AI waiter | `AI_MODEL`                 | no        |
| Staff assistant   | `STAFF_ASSISTANT_MODEL`    | no        |
| Menu photo reader | `MENU_IMPORT_VISION_MODEL` | no        |
| Menu suggestions  | `MENU_SUGGESTION_MODEL`    | yes       |
| AI drafts         | `AI_DRAFT_MODEL` (new)     | yes       |

`getModelsFor(job)` (`src/lib/ai/model-settings.ts`) decides, first usable wins:

1. **Saved on /admin**: a row in `platform_settings`, read with the service-role client and
   cached for 60 seconds per server instance.
2. **The Vercel variable** above.
3. **The built-in default** in `src/lib/ai/config.ts`.

A free-only job drops paid models from each source before deciding. A failed read of the store is
logged (`platform_settings_read_failed`) and treated as "nothing saved" for 15 seconds, so the
waiter carries on with its Vercel variable. The waiter on `AI_PROVIDER=anthropic` ignores saved
lists, because it takes one Anthropic model name, not an OpenRouter list.

**AI drafts now have their own list.** They used to borrow the waiter's, so a paid waiter model
switched drafting off. Their default is the free models in `AI_MODEL`, then the vetted suggestion
models.

## Changing a model (Phase 2)

Each job's row has **Change**. It opens three dropdowns (**Main model**, **Backup 1**,
**Backup 2**) listing the models this app has tested for that job, each with a note on what the
testing found and its price from OpenRouter's public model list. **Other…** takes any OpenRouter
model name.

**Test** sends one real request for that job to exactly the list chosen and shows, a few seconds
later: pass or fail, each check with a tick or a cross, the reply, how long it took, what it cost
(OpenRouter's own figure), and which model answered. Nothing is written anywhere:

| Job               | The test                                                                           | Passes when                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Diner's AI waiter | "What's vegetarian and not too spicy?" against a built-in sample menu, real prompt | it used the menu tool, answered, named only vegetarian dishes from the menu, leaked no instructions |
| Staff assistant   | "we've run out of paneer tikka for tonight"                                        | it reads "sold out" for paneer tikka (read, never run)                                              |
| Menu photo reader | `tests/fixtures/menu-board.jpg`                                                    | at least 11 of the 12 prices right, and no price invented for the "ask at counter" line             |
| Menu suggestions  | five dish names                                                                    | all five back, with ingredients, allergens and spice inside the allowed lists                       |
| AI drafts         | one dish description into Spanish                                                  | a translation comes back                                                                            |

The tests and their pass marks are in `src/lib/admin/model-test-core.ts` (the same bar as
`scripts/vet-models-by-job.ts`); the calls are in `src/lib/admin/model-test.ts`. The waiter's
sample menu is invented, and its cart and order tools are refused during a test.

**Save** stays greyed out until a Test has passed on exactly the list shown; changing a dropdown
afterwards greys it out again. Save asks once more ("Diners will start using … within about a
minute. Continue?"). The server checks before testing and again before saving: one to three
models, no repeats, free-only jobs take only `:free` models, every name must be on OpenRouter's
list, and not the `openrouter/free` alias. Then `save_platform_models()` (service role only)
checks that a passing Test of that exact list, for that job, by the same person, ran in the last
15 minutes, saves it, and writes a history row with the test result. The server that saved it
uses the new list at once; the others within a minute.

A Test on a paid model spends real credit, typically under a cent for the text jobs.

## The store

`20261023090000_platform_settings.sql`: `platform_settings` (one row per job, 1–3 models) and
`platform_settings_history` (who, when, old, new, test result, action). RLS is on with no policy and
the table privileges are revoked from `anon` and `authenticated`, so only the server reads or writes
them. `20261024090000_admin_model_tests.sql` adds `platform_model_tests` (every Test run on
/admin, same protections) and `save_platform_models()`, the only way a list is saved.

## Still to come

- **Phase 3:** spending (OpenRouter balance and monthly spend), change history with Undo, and an
  emergency reset.
