import type { ParseOptions } from "./parser-options.js"

/**
 * A template language Herb can parse into its HTML+ERB syntax tree.
 *
 * `erb` is the default. `slim` parses a Slim template into the same tree, with
 * locations pointing into the Slim source.
 */
export type TemplateLanguage = "erb" | "slim"

export const TEMPLATE_LANGUAGES: readonly TemplateLanguage[] = ["erb", "slim"]

/**
 * File extensions that are parsed as Slim, without the leading dot.
 * Compound extensions like `.html.slim` end in `.slim` and are covered as well.
 */
export const SLIM_FILE_EXTENSIONS: readonly string[] = ["slim"]

/**
 * Editor language ids (as VS Code and other LSP clients name them) that are parsed as Slim.
 */
export const SLIM_LANGUAGE_IDS: readonly string[] = ["slim"]

function stripQueryAndFragment(path: string): string {
  return path.replace(/[?#].*$/, "")
}

/**
 * Whether a file path or URI names a Slim template, going by its extension.
 *
 *     isSlimPath("app/views/users/show.html.slim") // => true
 *     isSlimPath("file:///app/views/users/show.html.erb") // => false
 */
export function isSlimPath(path: string | null | undefined): boolean {
  if (!path) return false

  const normalized = stripQueryAndFragment(path).toLowerCase()

  return SLIM_FILE_EXTENSIONS.some(extension => normalized.endsWith(`.${extension}`))
}

/**
 * The template language to parse a file with, chosen from its path or URI.
 *
 * Anything that isn't recognized as another template language is parsed as ERB,
 * which keeps `.html`, `.herb`, `.erb` and snippets without a path on the default.
 *
 *     languageForPath("app/views/users/show.html.slim") // => "slim"
 *     languageForPath("app/views/users/show.html.erb") // => "erb"
 *     languageForPath(undefined) // => "erb"
 */
export function languageForPath(path: string | null | undefined): TemplateLanguage {
  return isSlimPath(path) ? "slim" : "erb"
}

/**
 * The template language for an editor document, from its language id and, as a
 * fallback for clients that don't know the language, its URI.
 */
export function languageForDocument(document: { uri?: string, languageId?: string }): TemplateLanguage {
  if (document.languageId && SLIM_LANGUAGE_IDS.includes(document.languageId)) return "slim"

  return languageForPath(document.uri)
}

/**
 * A human readable name for a template language, for messages.
 */
export function templateLanguageName(language: TemplateLanguage): string {
  switch (language) {
    case "slim": return "Slim"
    case "erb": return "ERB"
  }
}

/**
 * A Slim shortcut: the character(s) before a name (`#main`, `.card`, `~submit`) and what they
 * expand to. `attr` names the attribute (or attributes) the name is written into, `tag` the tag
 * the shortcut creates when it starts a line. Mirrors Slim's `:shortcut` option.
 */
export interface SlimShortcut {
  attr?: string | string[]
  tag?: string
}

/**
 * The Slim settings a project can configure in `.herb.yml` under `slim:`. They mirror the
 * options of the same name the Slim gem is configured with, so templates parse the way they render.
 */
export interface SlimTemplateOptions {
  /** Replaces the default shortcuts, like Slim's `:shortcut` option does. */
  shortcuts?: Record<string, SlimShortcut>
  /** Attributes whose repeated values are joined, and the separator. Replaces the default, like Slim's `:merge_attrs`. */
  merge_attrs?: Record<string, string>
}

/** Slim's default `:shortcut` option. */
export const DEFAULT_SLIM_SHORTCUTS: Readonly<Record<string, SlimShortcut>> = Object.freeze({
  "#": { attr: "id" },
  ".": { attr: "class" },
})

/** Slim's default `:merge_attrs` option. */
export const DEFAULT_SLIM_MERGE_ATTRS: Readonly<Record<string, string>> = Object.freeze({
  class: " ",
})

/**
 * What `parserOptionsForPath` needs from a project's configuration. `Config` from
 * `@herb-tools/config` fits it, and so does a plain object.
 */
export interface TemplateParserConfig {
  parserOptions?: ParseOptions
  slim?: SlimTemplateOptions
}

/**
 * The Slim settings with Slim's defaults filled in for whatever a project leaves out. A
 * configured map replaces the default one instead of adding to it, the way Slim's options do.
 */
export function resolveSlimTemplateOptions(slim?: SlimTemplateOptions | null): Required<SlimTemplateOptions> {
  return {
    shortcuts: slim?.shortcuts ?? { ...DEFAULT_SLIM_SHORTCUTS },
    merge_attrs: slim?.merge_attrs ?? { ...DEFAULT_SLIM_MERGE_ATTRS },
  }
}

/**
 * A shortcut in the parser's `slim_shortcuts` shape: whitespace-separated attribute names and an
 * optional `tag:name`.
 *
 *     slimShortcutParserValue({ attr: "data-testid" })            // => "data-testid"
 *     slimShortcutParserValue({ tag: "section", attr: ["a", "b"] }) // => "tag:section a b"
 */
export function slimShortcutParserValue(shortcut: SlimShortcut): string {
  const attributes = shortcut.attr === undefined ? [] : Array.isArray(shortcut.attr) ? shortcut.attr : [shortcut.attr]
  const tokens = shortcut.tag ? [`tag:${shortcut.tag}`, ...attributes] : attributes

  return tokens.join(" ")
}

/**
 * The parser options that carry a project's Slim settings to the Slim frontend: `slim_shortcuts`
 * (shortcut => "attribute names and an optional tag:name") and `slim_merge_attrs`
 * (attribute => separator), both string maps that replace the parser's defaults.
 *
 * This is the one place that turns `.herb.yml` settings into parser options, so if the parser's
 * option shapes change, only this function does. The Ruby side mirrors it in
 * `Herb::Configuration#slim_parser_options`.
 */
export function slimParserOptions(slim?: SlimTemplateOptions | null): ParseOptions {
  const { shortcuts, merge_attrs } = resolveSlimTemplateOptions(slim)

  const slimShortcuts: Record<string, string> = {}

  for (const [key, shortcut] of Object.entries(shortcuts)) {
    slimShortcuts[key] = slimShortcutParserValue(shortcut)
  }

  return {
    slim_shortcuts: slimShortcuts,
    slim_merge_attrs: { ...merge_attrs },
  } as ParseOptions
}

/**
 * The parser options to parse a file with: the project's parser options, the template language
 * chosen from the path, and for Slim files the project's Slim settings.
 *
 *     parserOptionsForPath("app/views/users/show.html.slim", config)
 *     // => { erb_openers: [...], language: "slim", slim_shortcuts: { "#": "id", ... }, slim_merge_attrs: { class: " " } }
 *
 * Every tool that parses a file from disk or an editor goes through this, so a `.slim` file is
 * never parsed as ERB and always with the project's shortcuts.
 */
export function parserOptionsForPath(path: string | null | undefined, config?: TemplateParserConfig | null): ParseOptions {
  return parserOptionsForLanguage(languageForPath(path), config)
}

/**
 * Like `parserOptionsForPath`, for a template whose language is already known.
 */
export function parserOptionsForLanguage(language: TemplateLanguage, config?: TemplateParserConfig | null): ParseOptions {
  const base = config?.parserOptions ?? {}

  if (language === "slim") {
    return { ...base, language, ...slimParserOptions(config?.slim) }
  }

  return { ...base, language }
}
