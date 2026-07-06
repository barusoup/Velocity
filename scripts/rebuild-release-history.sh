#!/usr/bin/env bash
# Rebuild main as a linear release-only history: one commit per shipped version.
# Run from the repo root after the v0.1.2 source commit exists on the current branch.
set -euo pipefail

V012_COMMIT="${1:?Usage: rebuild-release-history.sh <v0.1.2-commit-sha>}"

declare -a RELEASES=(
  "v0.0.0|e2bcbf6e67d2550c0b92f5d6f9f7326912563bd2"
  "v0.0.1|0996c89d3ffd4b9a8da800cb8ef6626a7ea734be"
  "v0.0.2|9477e34520a449066135961646fdc804a4ee20a3"
  "v0.1.0|ab020d49345de3356f90811b383630e9269aff01"
  "v0.1.1|495120c9e32381897a23c38896dfd937e562da05"
  "v0.1.2|${V012_COMMIT}"
)

declare -A TAG_MESSAGES
TAG_MESSAGES[v0.0.0]="Velocity 0.0.0

First Preview release"
TAG_MESSAGES[v0.0.1]="$(git tag -l --format='%(contents:subject)%0a%0a%(contents:body)' v0.0.1 2>/dev/null || true)"
TAG_MESSAGES[v0.0.2]="$(git tag -l --format='%(contents:subject)%0a%0a%(contents:body)' v0.0.2 2>/dev/null || true)"
TAG_MESSAGES[v0.1.0]="$(git tag -l --format='%(contents:subject)%0a%0a%(contents:body)' v0.1.0 2>/dev/null || true)"
TAG_MESSAGES[v0.1.1]="$(git tag -l --format='%(contents:subject)%0a%0a%(contents:body)' v0.1.1 2>/dev/null || true)"
TAG_MESSAGES[v0.1.2]="$(git tag -l --format='%(contents:subject)%0a%0a%(contents:body)' v0.1.2 2>/dev/null || true)"

BACKUP_BRANCH="backup/pre-history-rewrite"
if ! git show-ref --verify --quiet "refs/heads/${BACKUP_BRANCH}"; then
  git branch "${BACKUP_BRANCH}" HEAD
  echo "Backed up current HEAD to ${BACKUP_BRANCH}"
fi

# Delete old tags locally; they are recreated on the new history.
for entry in "${RELEASES[@]}"; do
  tag="${entry%%|*}"
  git tag -d "$tag" 2>/dev/null || true
done

git checkout --orphan release-history
git rm -rf . >/dev/null 2>&1 || true

for entry in "${RELEASES[@]}"; do
  tag="${entry%%|*}"
  commit="${entry##*|}"
  ver="${tag#v}"

  echo "=== ${tag} <= ${commit} ==="
  # Checkout only tracked files at the release snapshot. Avoid `git add -A`,
  # which would sweep untracked workspace junk into the first orphan commit.
  git rm -rf . >/dev/null 2>&1 || true
  git checkout "$commit" -- .
  git commit -m "Velocity ${ver}"

  msg="${TAG_MESSAGES[$tag]}"
  if [ -z "$msg" ]; then
    msg="Velocity ${ver}"
  fi
  git tag -a "$tag" -m "$msg"
done

git branch -M release-history main
echo "Rebuilt release-only history on main."