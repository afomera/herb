import { languageForDocument } from "@herb-tools/core"

import type { TemplateLanguage } from "@herb-tools/core"

export interface LanguageDocument {
  uri: string
  languageId: string
}

/**
 * The template language of an editor document, from its language id or its extension.
 */
export function documentLanguage(document: LanguageDocument): TemplateLanguage {
  return languageForDocument(document)
}

/**
 * Whether a document is written in ERB.
 *
 * Features that read the tree (diagnostics, hover, definitions, folding, symbols, selection
 * ranges) work on every template language Herb parses. Features that write HTML+ERB back into the
 * document (completions, rewrites, extracting partials, comment toggling, on-type formatting) or
 * annotate close tags and `end`s (inlay hints) only apply to ERB. On a Slim document they return
 * nothing instead of inserting ERB.
 */
export function isERBDocument(document: LanguageDocument): boolean {
  return documentLanguage(document) === "erb"
}
