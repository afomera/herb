# Slim preview prereleases

Public GitHub prereleases of the `slim-support` branch on [afomera/herb](https://github.com/afomera/herb/releases), so the Slim support can be tried without building Herb, Emscripten or anything else locally.

Each prerelease is built by [`.github/workflows/slim-preview.yml`](../../.github/workflows/slim-preview.yml) when a `slim-preview-N` tag is pushed, and attaches:

- `herb-slim-preview.tgz`: one npm package with the `herb-lint`, `herb-format`, `herb-convert`, `herb-print`, `herb-highlight` and `herb-language-server` bins. Every `@herb-tools/*` package of the branch (with node-wasm's embedded `.wasm`) and all their dependencies are bundled inside it, so npm never resolves the registry's `@herb-tools/*` 0.11.0, which has no Slim support.
- `herb-lsp.vsix`: the VS Code extension.
- `SHA256SUMS`

The release notes hold the copy-paste install steps with the exact URLs for that tag.

## Cutting a prerelease

Commit everything, push the branch to the fork, then:

```bash
make prerelease            # tags HEAD as the next slim-preview-N and pushes the tag to `fork`
make prerelease DRY_RUN=1  # runs the checks and prints what would happen
make prerelease WATCH=1    # also follows the workflow run with `gh run watch`
```

The script ([`release.sh`](release.sh)) refuses when there are uncommitted changes or when `HEAD` isn't `fork/slim-support` after a fetch. It picks the next number from the `slim-preview-*` tags on the fork, checks that GitHub Actions is enabled there, and prints the run and release URLs. Override the defaults with `REMOTE=fork`, `REPO=afomera/herb` and `BRANCH=slim-support`.

GitHub Actions starts out disabled on forks. Enable it once under the fork's Actions tab ("I understand my workflows, go ahead and enable them"), or with:

```bash
gh api -X PUT repos/afomera/herb/actions/permissions -F enabled=true -f allowed_actions=all
```

The workflow only needs the default `GITHUB_TOKEN`, with `contents: write` to create the release.

## Installing a prerelease

Replace `slim-preview-N` with the tag from the [releases page](https://github.com/afomera/herb/releases).

**Ruby** (compiled from source, so Prism has to come from git too):

```ruby
gem "prism", github: "ruby/prism", tag: "v1.9.0"
gem "herb", github: "afomera/herb", tag: "slim-preview-N"
```

**npm:** remove any `@herb-tools/linter`, `@herb-tools/formatter` or `@herb-tools/printer` dev dependencies first, so their bins don't shadow these:

```bash
npm i -D https://github.com/afomera/herb/releases/download/slim-preview-N/herb-slim-preview.tgz
npx herb-lint app/views
npx herb-convert --stdout app/views/users/show.html.slim
```

**VS Code:**

```bash
curl -LO https://github.com/afomera/herb/releases/download/slim-preview-N/herb-lsp.vsix
code --install-extension herb-lsp.vsix
```

**`.herb.yml`:**

```yaml
slim:
  shortcuts:
    "#": { attr: id }
    ".": { attr: class }
    "~": { attr: data-testid }
  merge_attrs:
    class: " "
    data-controller: " "
```

## Building the npm package locally

```bash
yarn build
script/slim-preview/pack.sh                                   # writes tmp/slim-preview/herb-slim-preview.tgz
script/slim-preview/smoke.sh tmp/slim-preview/herb-slim-preview.tgz
```

`smoke.sh` installs the tarball into a fresh project offline, with an empty npm cache, and runs `herb-lint` and `herb-convert` against a Slim template.
