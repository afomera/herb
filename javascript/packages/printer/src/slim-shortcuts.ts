/**
 * Slim's shortcut configuration, in the shape of Herb's `slim_shortcuts` parser option: each shortcut maps to
 * whitespace-separated tokens, an attribute name (`attr:` prefix optional), `tag:name` or `name=value` (Slim's
 * `additional_attrs`). `slimParserOptions` in `@herb-tools/core` builds it from a project's `.herb.yml`.
 */
export type SlimShortcutsOption = Record<string, string>

/** Herb's `slim_merge_attrs` parser option: attribute name => separator. */
export type SlimMergeAttrsOption = Record<string, string>

/** Slim's defaults, `{ "#" => { attr: "id" }, "." => { attr: "class" } }`, as a `slim_shortcuts` value. */
export const SLIM_SHORTCUTS_OPTION_DEFAULT: SlimShortcutsOption = { "#": "id", ".": "class" }

/** Slim's default `merge_attrs`, as a `slim_merge_attrs` value. */
export const SLIM_MERGE_ATTRS_OPTION_DEFAULT: SlimMergeAttrsOption = { class: " " }

export interface ParsedSlimShortcut {
  key: string
  tag: string | null
  attributes: string[]
  additional: [string, string][]
}

export function parseSlimShortcutsOption(shortcuts: SlimShortcutsOption = SLIM_SHORTCUTS_OPTION_DEFAULT): ParsedSlimShortcut[] {
  return Object.entries(shortcuts).map(([key, value]) => {
    const shortcut: ParsedSlimShortcut = { key, tag: null, attributes: [], additional: [] }

    for (const token of value.split(/[\s,]+/).filter(Boolean)) {
      if (token.startsWith("tag:")) {
        shortcut.tag = token.slice(4)
      } else if (token.indexOf("=") > 0) {
        const index = token.indexOf("=")
        shortcut.additional.push([token.slice(0, index), token.slice(index + 1)])
      } else {
        shortcut.attributes.push(token.startsWith("attr:") ? token.slice(5) : token)
      }
    }

    return shortcut
  })
}
