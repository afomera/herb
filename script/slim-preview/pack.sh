#!/usr/bin/env bash
#
# Packs the already built @herb-tools/* packages of this checkout into one
# self-contained npm tarball, herb-slim-preview.tgz.
#
# Every @herb-tools package and all of its third-party dependencies are bundled
# (bundleDependencies) inside the tarball, so `npm i -D <tarball>` never
# resolves @herb-tools/* from the npm registry, where 0.11.0 lacks Slim.
#
# Usage:
#   script/slim-preview/pack.sh [output-directory]
#
# Environment:
#   PREVIEW_VERSION  version of the wrapper package (default: <core version>-slim-preview.local)
#   PREVIEW_SHA      commit recorded in the package (default: git rev-parse HEAD)
#
# Run `yarn build` first. The script only reads the packages' dist/ and build/ folders.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script_dir="$root/script/slim-preview"
packages_dir="$root/javascript/packages"
output_dir="$(mkdir -p "${1:-$root/tmp/slim-preview}" && cd "${1:-$root/tmp/slim-preview}" && pwd)"

# Every @herb-tools package the bundled bins need, directly or transitively.
packages=(
  core
  node-wasm
  config
  client
  analysis
  tailwind-class-sorter
  printer
  rewriter
  highlighter
  linter
  formatter
  language-service
  language-server
)

core_version="$(node -p "require('$packages_dir/core/package.json').version")"
version="${PREVIEW_VERSION:-$core_version-slim-preview.local}"
sha="${PREVIEW_SHA:-$(git -C "$root" rev-parse HEAD)}"

for package in "${packages[@]}"; do
  if [ ! -d "$packages_dir/$package/dist" ]; then
    echo "error: javascript/packages/$package/dist is missing, run \`yarn build\` first" >&2
    exit 1
  fi
done

if [ ! -f "$packages_dir/node-wasm/build/libherb.js" ]; then
  echo "error: javascript/packages/node-wasm/build/libherb.js is missing, run \`yarn build\` first" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/herb-slim-preview.XXXXXX")"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/vendor" "$work/package"

echo "==> Packing @herb-tools packages ($core_version)"

for package in "${packages[@]}"; do
  (cd "$packages_dir/$package" && npm pack --ignore-scripts --silent --pack-destination "$work/vendor" >/dev/null)
done

ls "$work/vendor"

echo "==> Installing them into the wrapper package"

cp -R "$script_dir/template/." "$work/package/"

node - "$work" "$version" "$sha" "${packages[@]}" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")

const [work, version, sha, ...packages] = process.argv.slice(2)
const vendor = path.join(work, "vendor")
const dependencies = {}

for (const file of fs.readdirSync(vendor)) {
  const name = "@herb-tools/" + file.replace(/^herb-tools-/, "").replace(/-\d+\.\d+\.\d+.*\.tgz$/, "")
  dependencies[name] = `file:../vendor/${file}`
}

const manifest = {
  name: "herb-slim-preview",
  version,
  private: true,
  dependencies,
}

fs.writeFileSync(path.join(work, "package", "package.json"), JSON.stringify(manifest, null, 2) + "\n")
NODE

(
  cd "$work/package"
  npm install --omit=dev --omit=peer --ignore-scripts --install-links --no-audit --no-fund --loglevel=error
)

echo "==> Checking that every @herb-tools package came from this checkout"

node - "$work/package" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")

const directory = process.argv[2]
const lock = JSON.parse(fs.readFileSync(path.join(directory, "package-lock.json"), "utf8"))
const problems = []

for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location.includes("@herb-tools/")) continue

  if (location.lastIndexOf("node_modules/") !== location.indexOf("node_modules/")) {
    problems.push(`${location} is nested, expected a single copy`)
  }

  if (entry.resolved && !entry.resolved.startsWith("file:")) {
    problems.push(`${location} resolved from ${entry.resolved}`)
  }
}

const wasm = path.join(directory, "node_modules/@herb-tools/node-wasm/build/libherb.js")

if (!fs.existsSync(wasm)) problems.push("node-wasm build/libherb.js (the embedded .wasm) is missing")

if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}

console.log("ok")
NODE

echo "==> Writing the final manifest"

node - "$work/package" "$version" "$sha" <<'NODE'
const fs = require("node:fs")
const path = require("node:path")

const [directory, version, sha] = process.argv.slice(2)
const manifestPath = path.join(directory, "package.json")
const installed = JSON.parse(fs.readFileSync(manifestPath, "utf8"))

// The bundled copies satisfy these exact versions, npm never fetches bundled dependencies.
const dependencies = {}

for (const name of Object.keys(installed.dependencies)) {
  const { version } = JSON.parse(fs.readFileSync(path.join(directory, "node_modules", name, "package.json"), "utf8"))
  dependencies[name] = version
}

const manifest = {
  name: "herb-slim-preview",
  version,
  description: `Herb tools with Slim support, built from afomera/herb@${sha}`,
  license: "MIT",
  repository: { type: "git", url: "git+https://github.com/afomera/herb.git" },
  herbSlimPreview: { commit: sha },
  bin: Object.fromEntries(fs.readdirSync(path.join(directory, "bin")).map((bin) => [bin, `bin/${bin}`])),
  files: ["bin/", "lib/", "README.md"],
  dependencies,
  bundleDependencies: Object.keys(dependencies),
}

fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
fs.rmSync(path.join(directory, "package-lock.json"))
NODE

cat > "$work/package/README.md" <<EOF
# herb-slim-preview

Herb's npm tools built from [afomera/herb@${sha:0:12}](https://github.com/afomera/herb/commit/$sha), with Slim support.

Bins: \`herb-lint\`, \`herb-format\`, \`herb-convert\`, \`herb-print\`, \`herb-highlight\`, \`herb-language-server\`.

All @herb-tools packages are bundled inside this package, nothing is resolved from the npm registry.
EOF

echo "==> Packing herb-slim-preview@$version"

tarball="$(cd "$work/package" && npm pack --ignore-scripts --silent --pack-destination "$work")"
mv "$work/$tarball" "$output_dir/herb-slim-preview.tgz"

echo "==> Verifying the tarball"

listing="$(tar -tzf "$output_dir/herb-slim-preview.tgz")"

for expected in \
  package/bin/herb-lint \
  package/bin/herb-convert \
  package/node_modules/@herb-tools/node-wasm/build/libherb.js \
  package/node_modules/@herb-tools/linter/dist/herb-lint.js \
  package/node_modules/@herb-tools/printer/dist/herb-convert.js; do
  if ! grep -qx "$expected" <<<"$listing"; then
    echo "error: $expected is missing from the tarball" >&2
    exit 1
  fi
done

echo "$output_dir/herb-slim-preview.tgz ($(du -h "$output_dir/herb-slim-preview.tgz" | cut -f1), $(wc -l <<<"$listing" | tr -d ' ') files)"
