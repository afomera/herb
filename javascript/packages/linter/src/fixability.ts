import { ruleAutofixesIn } from "./rule-languages.js"

import type { TemplateLanguage } from "@herb-tools/core"
import type { LintOffense, RuleClass } from "./types.js"

export interface Fixability {
  autocorrectable: boolean
  unsafeAutocorrectable: boolean
}

const NOT_FIXABLE: Fixability = { autocorrectable: false, unsafeAutocorrectable: false }

/**
 * Whether an offense can be fixed, and how safely.
 *
 * @param language - The template language of the file the offense is in. A fix that isn't safe to
 *   write into that language (every parser rule fix, for Slim) is reported as not fixable.
 */
export function fixabilityFor(offense: LintOffense, ruleClass: RuleClass | undefined, language: TemplateLanguage = "erb"): Fixability {
  if (!ruleClass) return NOT_FIXABLE
  if (!ruleAutofixesIn(ruleClass, language)) return NOT_FIXABLE
  if (ruleClass.autofixRequiresContext === true && !offense.autofixContext) return NOT_FIXABLE

  const correctable = ruleClass.autocorrectable === true
  const unsafe = ruleClass.unsafeAutocorrectable === true || offense.autofixContext?.unsafe === true

  if (!correctable && !unsafe) return NOT_FIXABLE

  return { autocorrectable: correctable && !unsafe, unsafeAutocorrectable: unsafe }
}
