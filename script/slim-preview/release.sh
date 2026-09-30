#!/usr/bin/env bash
#
# Cuts a Slim preview prerelease: tags HEAD as the next `slim-preview-N` and
# pushes the tag to the fork, which runs .github/workflows/slim-preview.yml.
#
# Usage:
#   make prerelease
#   make prerelease DRY_RUN=1
#   make prerelease WATCH=1
#
# Environment:
#   REMOTE   git remote to tag on (default: fork)
#   REPO     GitHub repository of that remote (default: afomera/herb)
#   BRANCH   branch that must be pushed (default: slim-support)
#   DRY_RUN  1 to run the checks and print what would happen, without tagging or pushing
#   WATCH    1 to follow the workflow run with `gh run watch` after pushing

set -euo pipefail

REMOTE="${REMOTE:-fork}"
REPO="${REPO:-afomera/herb}"
BRANCH="${BRANCH:-slim-support}"
DRY_RUN="${DRY_RUN:-0}"
WATCH="${WATCH:-0}"

prefix="slim-preview-"
workflow="slim-preview.yml"
failed=0

cd "$(git rev-parse --show-toplevel)"

dry_run() { [ "$DRY_RUN" = "1" ]; }

fail() {
  echo "error: $*" >&2

  if dry_run; then
    failed=1
  else
    exit 1
  fi
}

run() {
  if dry_run; then
    echo "[dry run] $*"
  else
    "$@"
  fi
}

dry_run && echo "==> Dry run, nothing will be tagged or pushed"

echo "==> Checking the working tree"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  fail "the working tree has uncommitted changes, commit or stash them first"
fi

untracked="$(git status --porcelain --untracked-files=normal | grep '^??' || true)"

if [ -n "$untracked" ]; then
  echo "warning: untracked files are not part of the prerelease:"
  echo "$untracked"
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "$current_branch" != "$BRANCH" ]; then
  echo "warning: on branch $current_branch, not $BRANCH"
fi

if ! git cat-file -e "HEAD:.github/workflows/$workflow" 2>/dev/null; then
  fail ".github/workflows/$workflow is not committed on HEAD, the tag would not trigger a build"
fi

echo "==> Fetching $REMOTE/$BRANCH"

git fetch --quiet "$REMOTE" "$BRANCH"

head_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "refs/remotes/$REMOTE/$BRANCH" 2>/dev/null || git rev-parse FETCH_HEAD)"

if [ "$head_sha" != "$remote_sha" ]; then
  fail "HEAD ($head_sha) is not $REMOTE/$BRANCH ($remote_sha), push the branch first: git push $REMOTE HEAD:$BRANCH"
fi

echo "==> Checking GitHub Actions on $REPO"

if command -v gh >/dev/null 2>&1; then
  if actions_enabled="$(gh api "repos/$REPO/actions/permissions" --jq '.enabled' 2>/dev/null)"; then
    if [ "$actions_enabled" != "true" ]; then
      cat >&2 <<EOF
GitHub Actions is disabled on $REPO, so the tag would not build anything. Enable it with:

  gh api -X PUT repos/$REPO/actions/permissions -F enabled=true -f allowed_actions=all

or under https://github.com/$REPO/settings/actions. Forks also need the one-time
"I understand my workflows, go ahead and enable them" button on https://github.com/$REPO/actions.
EOF
      fail "GitHub Actions is disabled on $REPO"
    fi
  else
    echo "warning: could not read the Actions permissions of $REPO, check https://github.com/$REPO/actions"
  fi
else
  echo "warning: gh is not installed, skipping the Actions check"
fi

echo "==> Finding the next $prefix tag on $REMOTE"

last="$(
  git ls-remote --tags --refs "$REMOTE" "refs/tags/$prefix*" |
    sed -n "s#.*refs/tags/$prefix\([0-9][0-9]*\)\$#\1#p" |
    sort -n |
    tail -n 1
)"

number=$(( ${last:-0} + 1 ))
tag="$prefix$number"

while git rev-parse -q --verify "refs/tags/$tag" >/dev/null; do
  echo "warning: $tag exists locally but not on $REMOTE, skipping it"
  number=$(( number + 1 ))
  tag="$prefix$number"
done

echo "    last: ${last:+$prefix}${last:-none}, next: $tag"
echo "    commit: $head_sha ($(git log -1 --format=%s HEAD))"

if [ "$failed" = "1" ]; then
  echo "==> Dry run finished with errors, a real run would stop at the first one" >&2
  exit 1
fi

echo "==> Tagging $tag and pushing it to $REMOTE"

run git tag -a "$tag" -m "Slim preview $number" "$head_sha"
run git push "$REMOTE" "refs/tags/$tag"

actions_url="https://github.com/$REPO/actions/workflows/$workflow"
release_url="https://github.com/$REPO/releases/tag/$tag"

if dry_run; then
  echo "[dry run] would print the run of $tag from $actions_url"
  echo "[dry run] release: $release_url"
  exit 0
fi

echo "==> Waiting for the workflow run"

run_id=""
run_url=""

if command -v gh >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    run_info="$(gh run list -R "$REPO" --workflow "$workflow" --limit 20 --json databaseId,headBranch,url \
      --jq ".[] | select(.headBranch == \"$tag\") | \"\(.databaseId) \(.url)\"" 2>/dev/null | head -n 1 || true)"

    if [ -n "$run_info" ]; then
      run_id="${run_info%% *}"
      run_url="${run_info#* }"
      break
    fi

    sleep 3
  done
fi

if [ -n "$run_url" ]; then
  echo "    run: $run_url"
else
  echo "    no run found yet, check $actions_url"
fi

echo "    release (once the run finishes): $release_url"

if [ "$WATCH" = "1" ] && [ -n "$run_id" ]; then
  gh run watch "$run_id" -R "$REPO" --exit-status
else
  [ -n "$run_id" ] && echo "    follow it with: gh run watch $run_id -R $REPO"
fi

exit 0
