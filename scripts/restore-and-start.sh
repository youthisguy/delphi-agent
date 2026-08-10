#!/usr/bin/env bash
# Render Start Command: bash scripts/restore-and-start.sh
#
# checkpoint.ts commits + pushes data/ to git as the durable backup of
# journal.jsonl / summary.json / runtime-config.json, since Render's disk
# is ephemeral. On a plain crash-restart Render just re-execs the same
# container, so the disk (and data/) is usually still intact — but on any
# fresh deploy (new build, or an instance rescheduled onto new storage)
# it starts from the built image only, WITHOUT your latest checkpointed
# data/. This pulls the latest committed data/ from git before boot so
# the app never starts cold.
set -euo pipefail

echo "[boot] fetching latest committed data/ from git..."

if [ -d .git ]; then
  git fetch origin "$(git rev-parse --abbrev-ref HEAD)" --quiet || echo "[boot] git fetch failed, continuing with what's on disk"
  # Only restore data/ specifically — never touch anything else that
  # might differ between the deployed build and HEAD.
  git checkout "origin/$(git rev-parse --abbrev-ref HEAD)" -- data/ 2>/dev/null \
    && echo "[boot] restored data/ from origin" \
    || echo "[boot] no data/ on origin yet (first run) or checkout failed, continuing with local data/"
else
  echo "[boot] not a git checkout at runtime — skipping restore (expected if Render deploys a built artifact without .git)"
fi

echo "[boot] starting server + trading loop..."
exec npx concurrently -k "npx tsx src/server.ts" "npx tsx src/index.ts"