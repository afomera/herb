#!/usr/bin/env bash
#
# Installs herb-slim-preview.tgz into a fresh project, offline and with an empty
# npm cache, then runs herb-lint and herb-convert against a Slim template.
#
# Usage:
#   script/slim-preview/smoke.sh <path-to-herb-slim-preview.tgz>

set -euo pipefail

tarball="$(cd "$(dirname "${1:?usage: smoke.sh <herb-slim-preview.tgz>}")" && pwd)/$(basename "$1")"
project="$(mktemp -d "${TMPDIR:-/tmp}/herb-slim-smoke.XXXXXX")"
trap 'rm -rf "$project"' EXIT

cd "$project"

cat > package.json <<'EOF'
{ "name": "herb-slim-smoke", "version": "0.0.0", "private": true }
EOF

cat > .herb.yml <<'EOF'
slim:
  shortcuts:
    "#": { attr: id }
    ".": { attr: class }
    "~": { attr: data-testid }
  merge_attrs:
    class: " "
    data-controller: " "
EOF

mkdir -p app/views/users

cat > app/views/users/show.html.slim <<'EOF'
.profile#user-card~profile-card data-controller="hello" data-controller="tooltip"
  h1.title = @user.name
  ~test-id Hello
  p
    | Welcome back
EOF

echo "==> npm i -D herb-slim-preview.tgz (offline, empty cache)"
npm i -D "$tarball" --offline --cache "$project/.npm-cache" --no-audit --no-fund --loglevel=error

echo "==> Checking that nothing came from the registry"
npm ls --all --offline >/dev/null

node - <<'NODE'
const lock = require("./package-lock.json")
const fromRegistry = Object.entries(lock.packages).filter(([location, entry]) => location && !entry.inBundle && !String(entry.resolved).startsWith("file:"))

if (fromRegistry.length) {
  console.error("resolved outside the tarball:", fromRegistry.map(([location]) => location))
  process.exit(1)
}

const bundled = Object.values(lock.packages).filter((entry) => entry.inBundle).length
console.log(`ok: ${bundled} bundled packages, none resolved from the registry`)
NODE

echo "==> npx herb-lint app/views"
npx --offline herb-lint app/views --no-color

echo "==> npx herb-convert --stdout app/views/users/show.html.slim"
output="$(npx --offline herb-convert --stdout app/views/users/show.html.slim)"
echo "$output"

for expected in 'data-testid="profile-card"' 'data-testid="test-id"' 'data-controller="hello tooltip"'; do
  if ! grep -qF "$expected" <<<"$output"; then
    echo "error: expected $expected in the converted output" >&2
    exit 1
  fi
done

echo "==> Smoke test passed"
