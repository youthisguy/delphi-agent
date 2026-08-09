#!/usr/bin/env bash
#
# One-command journal checkpoint: commits + pushes the current data/
# directory so open positions / journal history / summary survive the
# next deploy's fresh container. Safe to run any time — no-ops cleanly
# if nothing under data/ has changed since the last checkpoint.
#
# Required env vars (set these in Render's service Environment, or
# locally before running):
#   GIT_PUSH_URL     — full authenticated remote URL, e.g.
#                       https://x-access-token:<PAT>@github.com/<owner>/<repo>.git
#                       Use a GitHub Personal Access Token scoped to just
#                       this repo's contents (read+write). Do NOT reuse
#                       Render's own deploy key for this — that one is
#                       typically read-only and tied to Render's own
#                       checkout, not meant for app-triggered pushes.
#
# Optional env vars:
#   GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL — identity for the checkpoint
#                       commit (defaults below if unset)
#
# IMPORTANT: In Render's dashboard, set Build Filters → Ignored Paths to
# include `data/**`. Without that, this script's own push will trigger
# an auto-redeploy of the live trading loop the moment it lands — which
# defeats the point of a "commit data without restarting anything" tool.

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${GIT_PUSH_URL:-}" ]; then
  echo "GIT_PUSH_URL not set — refusing to push. See scripts/checkpoint.sh header." >&2
  exit 1
fi

git config user.name "${GIT_AUTHOR_NAME:-lazy-falcon-bot}"
git config user.email "${GIT_AUTHOR_EMAIL:-bot@localhost}"

git add data/ -A

if git diff --cached --quiet; then
  echo "No changes under data/ — nothing to checkpoint."
  exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
git commit -m "checkpoint: journal snapshot ${TIMESTAMP}" --quiet

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
# Render (and most PaaS deploy flows) check out a specific commit rather
# than a branch, leaving the deployed working copy in detached HEAD state
# — `git rev-parse --abbrev-ref HEAD` then returns the literal string
# "HEAD", and `git push URL HEAD:HEAD` fails. Fall back to an explicit
# target branch in that case. Defaults to "main"; set CHECKPOINT_BRANCH
# in the environment if your default branch is something else (e.g.
# "master").
if [ "$CURRENT_BRANCH" = "HEAD" ]; then
  CURRENT_BRANCH="${CHECKPOINT_BRANCH:-main}"
  echo "Detached HEAD detected (normal on Render's deploy checkout) — pushing to '${CURRENT_BRANCH}' instead. Set CHECKPOINT_BRANCH to override." >&2
fi
git push "${GIT_PUSH_URL}" "HEAD:${CURRENT_BRANCH}"

echo "Checkpoint pushed at ${TIMESTAMP} (branch: ${CURRENT_BRANCH})."