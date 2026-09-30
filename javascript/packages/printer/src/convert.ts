import { ReadableERBPrinter } from "./readable-erb-printer.js"
import { SlimPrinter } from "./slim-printer.js"
import { SLIM_MERGE_ATTRS_OPTION_DEFAULT, SLIM_SHORTCUTS_OPTION_DEFAULT } from "./slim-shortcuts.js"

import type { ParseOptions, ParseResult, TemplateLanguage } from "@herb-tools/core"
import type { ConversionDiagnostic } from "./conversion-diagnostic.js"
import type { SlimMergeAttrsOption, SlimShortcutsOption } from "./slim-shortcuts.js"

/** The part of a Herb backend (`@herb-tools/node-wasm`, `@herb-tools/node`) the converters use. */
export interface ConversionParser {
  parse(source: string, options?: ParseOptions): ParseResult
}

export interface ConvertOptions {
  /** Spaces per nesting level in the output. Defaults to 2. */
  indentWidth?: number
  /**
   * Parser options for the Slim side, e.g. `parserOptionsForLanguage("slim", config)` from `@herb-tools/core`.
   * Its `slim_shortcuts` and `slim_merge_attrs` are used to parse Slim, and to print it back with the same shortcuts.
   */
  slimParserOptions?: ParseOptions
  /** Parser options for the ERB side, e.g. `parserOptionsForLanguage("erb", config)`. */
  erbParserOptions?: ParseOptions
}

export interface ConversionResult {
  output: string
  /** Places where the output renders differently from the source (readable-mode semantic differences). */
  warnings: ConversionDiagnostic[]
  /** Parse errors in the source, and constructs that could not be converted. */
  errors: ConversionDiagnostic[]
}

type SlimOptions = { slim_shortcuts?: SlimShortcutsOption, slim_merge_attrs?: SlimMergeAttrsOption }

function slimOptions(options: ConvertOptions): Required<SlimOptions> {
  const slim = (options.slimParserOptions ?? {}) as SlimOptions

  return {
    slim_shortcuts: slim.slim_shortcuts ?? SLIM_SHORTCUTS_OPTION_DEFAULT,
    slim_merge_attrs: slim.slim_merge_attrs ?? SLIM_MERGE_ATTRS_OPTION_DEFAULT,
  }
}

function parseErrors(result: ParseResult): ConversionDiagnostic[] {
  return result.recursiveErrors().map(error => ({
    kind: "parse-error",
    message: error.message,
    line: error.location?.start.line ?? 1,
    column: error.location?.start.column ?? 0,
  }))
}

/** Slim => readable HTML+ERB (`<%= @url %>` attribute values, `<% if %>` ... `<% end %>`, indented). */
export function convertSlimToERB(herb: ConversionParser, source: string, options: ConvertOptions = {}): ConversionResult {
  const slim = slimOptions(options)
  const result = herb.parse(source, { ...options.slimParserOptions, ...slim, language: "slim", exact_semantics: false } as ParseOptions)

  const errors = parseErrors(result)
  if (errors.length > 0) return { output: "", warnings: [], errors }

  const printer = new ReadableERBPrinter({ indentWidth: options.indentWidth, mergeAttrs: slim.slim_merge_attrs })
  const output = printer.print(result)

  return { output, warnings: printer.warnings, errors: [] }
}

/** HTML+ERB => idiomatic Slim. */
export function convertERBToSlim(herb: ConversionParser, source: string, options: ConvertOptions = {}): ConversionResult {
  const erbOptions = { ...options.erbParserOptions, language: "erb" } as ParseOptions
  const result = herb.parse(source, erbOptions)

  const errors = parseErrors(result)
  if (errors.length > 0) return { output: "", warnings: [], errors }

  const slim = slimOptions(options)
  const printer = new SlimPrinter({
    indentWidth: options.indentWidth,
    shortcuts: slim.slim_shortcuts,
    mergeAttrs: slim.slim_merge_attrs,
    parse: html => herb.parse(html, erbOptions),
  })

  const output = printer.print(result)

  return { output, warnings: printer.warnings, errors: printer.errors }
}

export function convertTemplate(herb: ConversionParser, source: string, from: TemplateLanguage, to: TemplateLanguage, options: ConvertOptions = {}): ConversionResult {
  if (from === to) throw new Error(`Nothing to convert: the source and target language are both ${from}`)

  return from === "slim" ? convertSlimToERB(herb, source, options) : convertERBToSlim(herb, source, options)
}
