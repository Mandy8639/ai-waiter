#!/bin/sh
# Runs the AI waiter evaluation (evals/waiter.eval.ts). Takes only
# OPENROUTER_API_KEY from .env.local when it isn't already set: the suite
# never touches the database, so nothing else is loaded.
if [ -z "$OPENROUTER_API_KEY" ] && [ -f .env.local ]; then
  OPENROUTER_API_KEY=$(sed -n 's/^OPENROUTER_API_KEY=//p' .env.local | tr -d "\"'")
  export OPENROUTER_API_KEY
fi
exec npx vitest run --config vitest.evals.config.ts "$@"
