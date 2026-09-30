#!/usr/bin/env bash
#
# Prints the GitHub release notes for a Slim preview prerelease.
#
# Usage:
#   script/slim-preview/release-notes.sh <tag> <commit-sha> [owner/repo] [branch]

set -euo pipefail

tag="${1:?usage: release-notes.sh <tag> <commit-sha> [owner/repo] [branch]}"
sha="${2:?usage: release-notes.sh <tag> <commit-sha> [owner/repo] [branch]}"
repo="${3:-afomera/herb}"
branch="${4:-slim-support}"

download="https://github.com/$repo/releases/download/$tag"

cat <<EOF
Preview build of Herb's Slim support from the [\`$branch\`](https://github.com/$repo/tree/$branch) branch.

**Commit:** [\`$sha\`](https://github.com/$repo/commit/$sha)

This is a prerelease for trying Slim support, it is not published to RubyGems, npm or the VS Code Marketplace.

## Ruby

Add to your \`Gemfile\`. Herb is compiled from source, so Prism has to come from git as well:

\`\`\`ruby
gem "prism", github: "ruby/prism", tag: "v1.9.0"
gem "herb", github: "$repo", tag: "$tag"
\`\`\`

Or pin the exact commit:

\`\`\`ruby
gem "prism", github: "ruby/prism", tag: "v1.9.0"
gem "herb", github: "$repo", ref: "$sha"
\`\`\`

Then run \`bundle install\`.

## npm (\`herb-lint\`, \`herb-format\`, \`herb-convert\`, \`herb-print\`, \`herb-language-server\`)

\`\`\`bash
npm i -D $download/herb-slim-preview.tgz
\`\`\`

All \`@herb-tools/*\` packages are bundled inside this one tarball, nothing is resolved from the npm registry. Remove any \`@herb-tools/linter\`, \`@herb-tools/formatter\` or \`@herb-tools/printer\` dev dependencies first, so their bins don't shadow these.

\`\`\`bash
npx herb-lint app/views
npx herb-convert --stdout app/views/users/show.html.slim
\`\`\`

## Browser dev tools (\`@herb-tools/dev-tools\`)

\`\`\`bash
yarn add -D $download/herb-dev-tools.tgz   # or: npm i -D $download/herb-dev-tools.tgz
\`\`\`

Behind an https proxy such as puma-dev, point the overlay at a \`wss://\` URL for \`herb dev\` (for example \`echo "http://localhost:8592" > ~/.puma-dev/herb\` gives \`wss://herb.test\`) with \`<meta name="herb-dev-server-url" content="wss://herb.test">\` or \`HerbDevTools.start({ devServer: { url: "wss://herb.test" } })\`.

## VS Code

\`\`\`bash
curl -LO $download/herb-lsp.vsix
code --install-extension herb-lsp.vsix
\`\`\`

The extension has the same version as the Marketplace release, so turn off auto-update for the Herb LSP extension (\`marcoroth.herb-lsp\`) to keep this build.

## \`.herb.yml\`

\`\`\`yaml
slim:
  shortcuts:
    "#": { attr: id }
    ".": { attr: class }
    "~": { attr: data-testid }
  merge_attrs:
    class: " "
    data-controller: " "
\`\`\`

## Checksums

See [\`SHA256SUMS\`]($download/SHA256SUMS).
EOF
