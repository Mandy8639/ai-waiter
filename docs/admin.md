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
- An admin account needn't run a restaurant. With none, signing in (which lands on `/dashboard`)
  goes straight to `/admin` instead of "Create your restaurant", and the Admin page shows Account
  and Log out in place of its Dashboard link. To open a restaurant anyway, go to `/onboarding`.

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

| Job               | The test                                                                                                                              | Passes when                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Diner's AI waiter | "What's vegetarian and not too spicy?", then "What do you recommend?", each on a built-in sample menu with the real prompt and guards | it used the menu tool, answered, named only vegetarian dishes from the menu, then answered the second with a question (as its instructions say), and leaked no instructions either time |
| Staff assistant   | "we've run out of paneer tikka for tonight"                                                                                           | it reads "sold out" for paneer tikka (read, never run)                                                                                                                                  |
| Menu photo reader | `tests/fixtures/menu-board.jpg`                                                                                                       | at least 11 of the 12 prices right, and no price invented for the "ask at counter" line                                                                                                 |
| Menu suggestions  | five dish names                                                                                                                       | all five back, with ingredients, allergens and spice inside the allowed lists                                                                                                           |
| AI drafts         | one dish description into Spanish                                                                                                     | a translation comes back                                                                                                                                                                |

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

## Free safety net

The two jobs that run live during service, the **waiter** and the **staff assistant**, each have a
free safety net: tested free models they try when their whole saved list is busy. Only one free
model has held a real conversation as the waiter, so a busy free tier could otherwise leave it with
nothing to answer with. The owner-side jobs (photo reader, suggestions, drafts) have none: they
already have tested backups, a failure there is a retry rather than a diner waiting, and a wrong
price or allergen from an unproven model costs more than a short delay.

- **Daily check.** Once a day (Vercel Cron, 11:00 UTC, `/api/cron/free-model-check`, needs
  `CRON_SECRET`), each job's Test from the table above runs on every free (`:free`) model
  OpenRouter lists that could do the job (for the waiter, ones that call tools), up to 12 per job,
  six at a time: the staff assistant first (one short message each), then the waiter. Free models
  only, so it costs nothing. **Check now** on each job's card runs that job's check.
- **Who is in the net.** A model that passed that job's Test in the last three days, and whose
  latest check didn't fail. A model that was only busy keeps its last pass. Results are kept per
  job (`free_model_checks` is keyed by job and model), since a good command reader can still be a
  poor waiter.
- **Never used.** `NEVER_USE` in `src/lib/ai/safety-net-core.ts` lists, per job, models that pass
  the Test but failed in real use here (for the waiter: no lookups, made-up recommendations,
  reading out their instructions). They are never checked or used for that job, and `/admin` says
  why. Add a model there when it misbehaves live.
- **Order.** Models vetted for the job (its catalogue list) first, then the rest, fastest passing
  Test first. Speed only breaks ties among the unvetted, because it favours small models, which
  hold a conversation worst.
- **When it is used.** Only when OpenRouter answers busy (429), an HTTP error or a timeout for the
  job's whole saved list. The job then makes one more try with the top three models in its net,
  skipping any already in its own list. Logged as `waiter_safety_net_used` or
  `staff_safety_net_used`. The staff assistant's answer is still only a proposal: staff confirm
  every change before it happens.
- **Switches.** One per job on `/admin`. On by default (no row in `platform_switches` means on).

A Test pass is one good answer, not a track record, so the net only ever replaces "no answer at
all". Code: `src/lib/ai/safety-net-core.ts` (rules), `src/lib/ai/safety-net.ts` (read, cached a
minute), `src/lib/admin/safety-net-check.ts` (the daily check).

## The store

`20261023090000_platform_settings.sql`: `platform_settings` (one row per job, 1–3 models) and
`platform_settings_history` (who, when, old, new, test result, action). RLS is on with no policy and
the table privileges are revoked from `anon` and `authenticated`, so only the server reads or writes
them. `20261024090000_admin_model_tests.sql` adds `platform_model_tests` (every Test run on
/admin, same protections) and `save_platform_models()`, the only way a list is saved.
`20261025090000_waiter_safety_net.sql` adds `free_model_checks` (each free model's latest daily
check; free models only) and `platform_switches` (on/off switches), both server-only.
`20261026090000_staff_safety_net.sql` keys `free_model_checks` by job and model, and adds the staff
assistant's switch.

## Spending, history, Undo and reset (Phase 3)

- **Spending** (top of the page): credit left on the OpenRouter account, this month's and today's
  spend on the app's key, and the key's limit with how much is used. Read live from OpenRouter
  (`GET /api/v1/key` and `/api/v1/credits`) with the app's key on every view
  (`src/lib/admin/openrouter-spend.ts`). A figure OpenRouter didn't send shows "not reported",
  and if neither request works the card says it couldn't reach OpenRouter: never $0. The limit is
  set on OpenRouter and only shown here, so nothing on this page can raise it.
- **Change history**: the last 50 rows of `platform_settings_history`, newest first: when (UTC),
  who ("you" or "another admin"), which job, from what to what, and the Test that allowed it.
- **Undo** on a row puts back the list that change replaced, after one confirm. An earlier list
  is tested again first, exactly as Save would, and only saved if it passes today
  (`save_platform_models(..., 'undo')`). Going back to "nothing saved" needs no Test, because the
  Vercel variables and defaults are what ran before (`clear_platform_models(job, user)`). Either
  way it is recorded as an `undo` row. A row whose job is already back where it started has no
  Undo.
- **Emergency reset**: one confirm, then every saved list is cleared and every job is back on its
  Vercel variable or built-in default within about a minute (`clear_platform_models(null, user)`).
  Recorded as one `all`/`reset` row whose `test_result.cleared` keeps what was cleared, and who did
  it. There is no "save without testing"; this is the escape hatch. A reset itself has no Undo: use
  Change and Test to bring a list back.

Both functions are service-role only and listed in `function-grants.test.ts`
(`20261027090000_admin_undo_reset.sql`).

## AI cost per restaurant and the Monday email (Phase 4)

- **What is recorded.** `ai_usage` gets one row per AI use: a diner's waiter turn (all its
  tool-calling rounds added up), a staff command, a menu photo, a suggestion or draft batch, an
  Admin page Test or a safety-net check. Each row has the restaurant (null for platform use), job,
  model, calls, tokens and cost. Every OpenRouter request asks for its cost
  (`usage: { include: true }`, `USAGE_REQUEST` in `src/lib/ai/usage-core.ts`). A reply without one
  is priced from the model's listed price and marked `cost_estimated`. With neither, the cost stays
  null and is shown as "not counted", never as $0. Recording never fails the AI use
  (`src/lib/ai/usage.ts`). The waiter on `AI_PROVIDER=anthropic` isn't recorded yet.
- **On `/admin`.** The Spending card gains two tables, this week so far and last week (Monday to
  Monday, UTC): restaurant, waiter chats (diner messages answered), AI cost (every job), and cost
  per chat. Platform use (Tests and safety checks) is its own row. Data comes from
  `ai_cost_summary(from, to)`, which is service-role only.
- **The Monday email.** Vercel Cron, Mondays 12:00 UTC, `/api/cron/admin-weekly` (needs
  `CRON_SECRET` and `RESEND_API_KEY`). It goes to every address in `PLATFORM_ADMIN_EMAILS` with
  last week's totals; the subject carries the answer ("Tableside AI last week: $3.40 across 4
  restaurants, 0.4¢ per chat"), followed by the per-restaurant table. Each admin gets one per week:
  it is claimed in `platform_email_dispatches` before sending, and the same key goes to Resend as
  its Idempotency-Key.

`20261028090000_ai_usage.sql` adds `ai_usage`, `ai_cost_summary()` and `platform_email_dispatches`,
all server-only.

## Still to come

See the plan doc: side-by-side Test (Phase 5) and the later phases.
