# Nightly watch

A Claude Code agent that runs every night, checks that Tableside still works, and tells a human only
when something got worse. It runs as a scheduled routine (claude.ai/code/routines), from this file.

## What it does, in order

1. **Set up.** `npm ci`.
2. **Check production.** `npm run watch:health`: a few read-only requests to tableside.menu and the old
   domain (printed QR codes and Stripe webhooks still use it). If a check fails, wait two minutes and
   run it once more: a single blip is not news.
3. **Evaluate the waiter.** `EVAL_CONCURRENCY=2 npm run eval:waiter`, on the default free model.
4. **Compare.** `npm run eval:compare` prints last night against `evals/baseline.json` and exits 1 when
   something that passed in the baseline fails now.
5. **Investigate anything that got worse,** before telling anyone:
   - Re-run just the failing scenarios twice: `EVAL_ONLY=<ids> EVAL_REPEAT=2 npm run eval:waiter`.
     Free models are noisy; a scenario that passes on a re-run is flaky, not broken. Note it, don't
     raise it.
   - For one that keeps failing, read its transcript in the newest `evals/results/*.json` (the
     waiter's reply, its tool calls, the check that failed).
   - Look at what changed: `git log --since="3 days ago" --stat -- src/lib/ai src/lib/menu-graph evals`.
   - Work out the likeliest cause and the smallest fix. Read the code; don't guess.
6. **Report.**
   - **Quiet night** (production fine, nothing regressed, or only flaky scenarios): no issue. End with
     a three-line summary.
   - **Something is wrong:** open one GitHub issue labelled `nightly-watch` titled
     `Nightly watch: <date>: <what broke>`, or, if an open `nightly-watch` issue already covers it,
     comment on that one instead. Include: what failed, how often on re-run, the relevant transcript
     lines, the suspected commit, and the proposed fix with file and line.
7. **Vet one backup model for the waiter,** after the report is done, so it can never change what
   the report says. The waiter's backup pool only holds models that passed this evaluation, and today
   that's one model; each night tries one more.
   - Get the log of models already tried. It lives on the branch `claude/nightly-watch-state`, never
     on `main`:
     `git fetch origin claude/nightly-watch-state && git show origin/claude/nightly-watch-state:vetting-log.json > /tmp/vetting-log.json`
     (if the branch doesn't exist yet, start with `echo '{"tested":[]}' > /tmp/vetting-log.json`).
   - `npm run -s vet:models -- next --log /tmp/vetting-log.json` prints tonight's candidate, a free
     model that calls tools and wasn't tried this month. If it prints `none`, skip this step.
   - `EVAL_MODELS=<candidate> EVAL_CONCURRENCY=2 npm run eval:waiter`, then
     `npm run -s vet:models -- record --log /tmp/vetting-log.json --model <candidate>`. That prints the
     verdict and exits 0 for a pass, 2 for a fail.
   - Save the log: commit `/tmp/vetting-log.json` as `vetting-log.json` on `claude/nightly-watch-state`
     and push that branch. If the branch doesn't exist, create it as an orphan branch holding only
     that file.
   - **Passed:** branch `claude/waiter-backup-<model>` from `main`. Add the model to `TESTED_MODELS.waiter`
     in `src/lib/admin/model-catalogue.ts`, with a note like
     `Passed the waiter evaluation (92%) on 2026-10-28, nightly watch`. Run `npx tsc --noEmit -p .` and
     `npx vitest run tests/unit/safety-net-core.test.ts tests/unit/waiter-models.test.ts`. Then open a
     **draft** pull request titled `Waiter backup: <model> passed the evaluation`, labelled
     `nightly-watch`, with the verdict and the evaluation's Markdown summary. A human decides; never
     merge it. If you can't open a pull request from here, put all of that in your final message.
   - **Failed:** nothing more than a line in the summary (model, pass rate, reasons).

## Rules

- **Read-only on production.** Never sign in, scan a table QR (that creates a real diner session),
  place an order, call the database, or change any setting.
- **Free models only.** Paid models bill the owner. The only `EVAL_MODELS` value ever allowed is the
  one `:free` candidate `vet:models next` printed (step 7), and `vet:models record` refuses anything
  else.
- **Never push to `main`, merge, or deploy.** Proposing a fix is the job; making it is a human's call.
  The only branches you push are `claude/nightly-watch-state` (the vetting log) and a draft pull
  request's `claude/waiter-backup-*` branch.
- **One issue a night at most,** and never a duplicate of an open one. At most one vetting pull
  request a night.
- **No secrets in output.** Never print environment values, keys or tokens, in the issue or anywhere.
- **Don't chase CI.** A check that fails within a few seconds with no logs is GitHub Actions itself
  (often the account's minutes running out), not your change: never re-run it. Say so once in the
  pull request and in your summary, and leave the pull request as it is.
- **A busy model is not a regression.** Unjudged scenarios (rate limits, timeouts) are listed, not
  raised.
- When a scenario is fixed for good, a human runs `npm run eval:compare -- --update-baseline` after a
  full evaluation and commits `evals/baseline.json`. The agent doesn't move the baseline itself, so a
  regression can never quietly become the new normal.

## Needs

The routine's environment needs `OPENROUTER_API_KEY` (the evaluation's only secret), and the
`nightly-watch` label on the repository.
