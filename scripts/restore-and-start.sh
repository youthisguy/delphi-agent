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

BRANCH="${GIT_BRANCH:-main}"

if [ -d .git ]; then
  # Render's runtime container ships the .git directory from the build
  # step, but not a working, authenticated "origin" remote — the fetch
  # above failed with "origin does not appear to be a git repository"
  # because that remote simply isn't configured at runtime, not because
  # anything is broken. Reconstruct it from env vars if needed.
  #
  # Requires two Render env vars set on this service:
  #   GITHUB_REPO   e.g. "yourusername/delphi-agent"
  #   GITHUB_TOKEN  a GitHub PAT with at least read access to that repo
  if ! git remote get-url origin >/dev/null 2>&1; then
    if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
      echo "[boot] origin remote missing — reconstructing from GITHUB_REPO/GITHUB_TOKEN"
      git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
    else
      echo "[boot] origin remote missing and GITHUB_REPO/GITHUB_TOKEN not set — skipping restore"
    fi
  fi

  if git remote get-url origin >/dev/null 2>&1; then
    git fetch origin "$BRANCH" --quiet || echo "[boot] git fetch failed, continuing with what's on disk"
    # Only restore data/ specifically — never touch anything else that
    # might differ between the deployed build and HEAD.
    git checkout "origin/$BRANCH" -- data/ 2>/dev/null \
      && echo "[boot] restored data/ from origin" \
      || echo "[boot] no data/ on origin yet (first run) or checkout failed, continuing with local data/"
  fi
else
  echo "[boot] not a git checkout at runtime — skipping restore (expected if Render deploys a built artifact without .git)"
fi

echo "[boot] starting server + trading loop..."
exec npx concurrently -k "npx tsx src/server.ts" "npx tsx src/index.ts"