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

## Rules

- **Read-only on production.** Never sign in, scan a table QR (that creates a real diner session),
  place an order, call the database, or change any setting.
- **Free models only.** Never set `EVAL_MODELS`: paid models bill the owner.
- **Never push to `main`, merge, or deploy.** Proposing a fix is the job; making it is a human's call.
- **One issue a night at most,** and never a duplicate of an open one.
- **No secrets in output.** Never print environment values, keys or tokens, in the issue or anywhere.
- **A busy model is not a regression.** Unjudged scenarios (rate limits, timeouts) are listed, not
  raised.
- When a scenario is fixed for good, a human runs `npm run eval:compare -- --update-baseline` after a
  full evaluation and commits `evals/baseline.json`. The agent doesn't move the baseline itself, so a
  regression can never quietly become the new normal.

## Needs

The routine's environment needs `OPENROUTER_API_KEY` (the evaluation's only secret), and the
`nightly-watch` label on the repository.
