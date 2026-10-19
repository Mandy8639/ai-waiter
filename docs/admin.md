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

## AI models (Phase 1: read-only)

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

## The store

`20261023090000_platform_settings.sql`: `platform_settings` (one row per job, 1–3 models) and
`platform_settings_history` (who, when, old, new, test result, action). RLS is on with no policy and
the table privileges are revoked from `anon` and `authenticated`, so only the server reads or writes
them. Phase 1 only reads; Phase 2 adds the editor, which writes after a passing test.

## Still to come

- **Phase 2:** change models from the page, with a Test per job and Save only after a pass.
- **Phase 3:** spending (OpenRouter balance and monthly spend), change history with Undo, and an
  emergency reset.
