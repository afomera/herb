import type { TemplateLanguage } from "@herb-tools/core"
import type { RuleClass } from "./types.js"

/**
 * Where a rule's autofix may write when the rule doesn't say.
 *
 * Parser rule fixes mutate the tree and print it back with the HTML+ERB printers, and source rule
 * fixes rewrite raw ERB text, so neither is safe in another template language until a rule says so.
 *
 * TODO: Once a Slim printer exists, parser rule fixes can be printed back as Slim. Opt a rule in by
 * adding `"slim"` to its `autofixLanguages` and teach `Linter#autofix` to print with it.
 */
const DEFAULT_AUTOFIX_LANGUAGES: readonly TemplateLanguage[] = ["erb"]

/**
 * Whether a rule runs on a template written in the given language.
 *
 * Parser rules read the syntax tree, which every language Herb parses shares, so they run
 * everywhere unless they narrow `languages`. Lexer and source rules read ERB tokens or the raw ERB
 * text, so they only run on ERB unless they opt into more.
 */
export function ruleRunsOn(ruleClass: RuleClass, language: TemplateLanguage): boolean {
  if (ruleClass.languages) return ruleClass.languages.includes(language)
  if (ruleClass.type === "lexer" || ruleClass.type === "source") return language === "erb"

  return true
}

/**
 * Whether a rule's autofix is safe to apply to a template written in the given language.
 */
export function ruleAutofixesIn(ruleClass: RuleClass, language: TemplateLanguage): boolean {
  return (ruleClass.autofixLanguages ?? DEFAULT_AUTOFIX_LANGUAGES).includes(language)
}
