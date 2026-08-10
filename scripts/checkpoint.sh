#!/usr/bin/env bash
set -uo pipefail
# Commit + push data/ so trade receipts survive Render's ephemeral disk
# across redeploys. Safe to call from multiple Render services
# concurrently (dashboard server + trading loop both checkpoint
# independently) — conflicts are resolved without dropping receipts:
#
# - data/journal.jsonl is append-only, so .gitattributes marks it
#   `merge=union` — git's built-in union merge driver keeps every
#   unique line from both sides on conflict instead of picking one
#   side and discarding the other's newly-appended receipts.
# - data/summary.json and data/loop-status.json are full snapshots
#   recomputed every cycle regardless, so losing a stale remote
#   version on conflict is harmless — those fall back to "ours".
#
# Exits 0 on genuine no-op (nothing to commit). Non-zero + stderr output
# on any real failure; checkpoint.ts captures both and never treats a
# failure as fatal to the calling cycle.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "checkpoint: couldn't cd to repo root $REPO_ROOT"; exit 1; }

BRANCH="${CHECKPOINT_BRANCH:-main}"
MAX_PUSH_RETRIES=3

# Required on Render — deploy images have no git identity, so commit fails
# with "Author identity unknown" without this.
git config user.email "${GIT_AUTHOR_EMAIL:-checkpoint@delphi-agent.local}"
git config user.name "${GIT_AUTHOR_NAME:-lazy-falcon-bot}"

# Render's runtime often has no usable origin (or an unauthenticated one).
# Reconstruct from the same env vars restore-and-start.sh uses.
if [ -n "${GITHUB_REPO:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
fi

# Render's deploy checkout is often a detached HEAD — that's normal, not
# an error. We just need a real branch ref to push against.
CURRENT_REF="$(git symbolic-ref --short -q HEAD || true)"
if [ -z "$CURRENT_REF" ]; then
  echo "checkpoint: detached HEAD detected (normal on Render's deploy checkout) — targeting '$BRANCH' instead"
fi

git add data/ || { echo "checkpoint: git add failed"; exit 1; }

if git diff --cached --quiet; then
  echo "checkpoint: no changes in data/ — nothing to commit"
  exit 0
fi

COMMIT_MSG="checkpoint: $(date -u +'%Y-%m-%dT%H:%M:%SZ')"
if ! git commit -m "$COMMIT_MSG" >/dev/null 2>&1; then
  echo "checkpoint: git commit failed"
  git commit -m "$COMMIT_MSG" 2>&1 || true
  exit 1
fi

attempt=0
while [ "$attempt" -lt "$MAX_PUSH_RETRIES" ]; do
  attempt=$((attempt + 1))

  if ! git fetch origin "$BRANCH" 2>&1; then
    echo "checkpoint: git fetch origin $BRANCH failed on attempt $attempt"
    sleep $((attempt * 2))
    continue
  fi

  # Merge remote into our detached/local commit. .gitattributes' union
  # driver handles journal.jsonl conflicts by keeping both sides' lines;
  # -X ours is the fallback ONLY for files without a merge= attribute
  # (summary.json, loop-status.json) where the freshest local snapshot
  # is fine to prefer.
  if git merge --no-edit -X ours "origin/$BRANCH" 2>&1; then
    : # merged cleanly (or via union driver) — fall through to push
  else
    echo "checkpoint: merge with origin/$BRANCH had unresolved conflicts outside data/ — aborting merge, will retry"
    git merge --abort 2>/dev/null || true
    sleep $((attempt * 2))
    continue
  fi

  if git push origin "HEAD:$BRANCH" 2>&1; then
    echo "checkpoint: pushed to $BRANCH (attempt $attempt)"
    exit 0
  else
    echo "checkpoint: push rejected on attempt $attempt — likely a concurrent checkpoint from another service, retrying"
    sleep $((attempt * 2))
  fi
done

echo "checkpoint: failed after $MAX_PUSH_RETRIES attempts — commit is safe locally on this instance's disk, will retry next cycle"
exit 1