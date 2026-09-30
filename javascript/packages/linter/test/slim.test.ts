import dedent from "dedent"
import { describe, test, expect, beforeAll } from "vitest"

import { Herb } from "@herb-tools/node-wasm"
import { Location } from "@herb-tools/core"
import { Config } from "@herb-tools/config"

import { Linter } from "../src/linter.js"
import { rules } from "../src/rules.js"
import { fixabilityFor } from "../src/fixability.js"
import { ruleRunsOn, ruleAutofixesIn } from "../src/rule-languages.js"
import { parseHerbDisableLine } from "../src/herb-disable-comment-utils.js"
import { ParserRule, SourceRule, LexerRule } from "../src/types.js"

import { HTMLImgRequireAltRule } from "../src/rules/html-img-require-alt.js"
import { HTMLIframeHasTitleRule } from "../src/rules/html-iframe-has-title.js"
import { HTMLTagNameLowercaseRule } from "../src/rules/html-tag-name-lowercase.js"
import { HTMLBooleanAttributesNoValueRule } from "../src/rules/html-boolean-attributes-no-value.js"
import { ERBRequireWhitespaceRule } from "../src/rules/erb-require-whitespace-inside-tags.js"
import { ERBClosingTagIndentRule } from "../src/rules/erb-closing-tag-indent.js"
import { ERBRequireTrailingNewlineRule } from "../src/rules/erb-require-trailing-newline.js"
import { ERBNoExtraNewLineRule } from "../src/rules/erb-no-extra-newline.js"
import { ERBNoByteOrderMarkRule } from "../src/rules/erb-no-byte-order-mark.js"
import { SourceIndentationRule } from "../src/rules/source-indentation.js"
import { HerbDisableCommentUnnecessaryRule } from "../src/rules/herb-disable-comment-unnecessary.js"
import { HerbDisableCommentOutOfDateRule } from "../src/rules/herb-disable-comment-out-of-date.js"
import { HerbDisableCommentValidRuleNameRule } from "../src/rules/herb-disable-comment-valid-rule-name.js"
import { HTMLNoDuplicateAttributesRule } from "../src/rules/html-no-duplicate-attributes.js"
import { ParserNoErrorsRule } from "../src/rules/parser-no-errors.js"

import type { UnboundLintOffense, LintContext, LintOffense } from "../src/types.js"
import type { HTMLElementNode, LexResult, ParseResult } from "@herb-tools/core"

const SLIM_FILE = "app/views/users/show.html.slim"

function where(offense: LintOffense) {
  const { start, end } = offense.location

  return `${start.line}:${start.column}-${end.line}:${end.column}`
}

class ElementEdgesRule extends ParserRule {
  static ruleName = "test-element-edges"
  static introducedIn = this.version("unreleased")

  check(result: ParseResult): UnboundLintOffense[] {
    const element = result.value.children.find(node => node.type === "AST_HTML_ELEMENT_NODE") as HTMLElementNode

    return [
      this.createOffense("tag name", element.tag_name!.location),
      this.createOffense("close tag", element.close_tag!.location),
    ]
  }
}

class ERBSourceRule extends SourceRule {
  static ruleName = "test-erb-source"
  static introducedIn = this.version("unreleased")

  check(source: string): UnboundLintOffense[] {
    return [this.createOffense(`${source.length} characters`, Location.from(1, 0, 1, 1))]
  }
}

class AnyLanguageSourceRule extends ERBSourceRule {
  static ruleName = "test-any-language-source"
  static languages = ["erb", "slim"] as const
}

class TokenRule extends LexerRule {
  static ruleName = "test-token"
  static introducedIn = this.version("unreleased")

  check(lexResult: LexResult): UnboundLintOffense[] {
    return [this.createOffense(`${lexResult.value.length} tokens`, Location.from(1, 0, 1, 1))]
  }
}

describe("Linting Slim templates", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  describe("choosing the language", () => {
    test("parses .slim files as Slim, with locations in the Slim source", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule])

      const result = linter.lint(dedent`
        .card
          img src="avatar.png"
      ` + "\n", { fileName: SLIM_FILE })

      expect(result.offenses.map(where)).toEqual(["2:2-2:5"])
      expect(result.offenses[0].rule).toBe("html-img-require-alt")
    })

    test("parses plain .slim files as Slim", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule])
      const result = linter.lint(`img src="a.png"\n`, { fileName: "app/views/users/_card.slim" })

      expect(result.offenses.map(where)).toEqual(["1:0-1:3"])
    })

    test("never parses a .slim file as ERB", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule])

      expect(linter.lint(`img src="a.png"\n`, { fileName: SLIM_FILE }).offenses).toHaveLength(1)
      expect(linter.lint(`img src="a.png"\n`, { fileName: "app/views/users/show.html.erb" }).offenses).toHaveLength(0)
    })

    test("an explicit language wins over the file name", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule])

      expect(linter.lint(`img src="a.png"\n`, { language: "slim" }).offenses).toHaveLength(1)
      expect(linter.lint(`img src="a.png"\n`, { fileName: SLIM_FILE, language: "erb" }).offenses).toHaveLength(0)
    })

    test("snippets without a file name are ERB", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule])

      expect(linter.languageFor({})).toBe("erb")
      expect(linter.lint(`<img src="a.png">`).offenses).toHaveLength(1)
    })
  })

  describe("which rules run", () => {
    test("rules about ERB tag syntax don't run on Slim", () => {
      const linter = new Linter(Herb, [ERBRequireWhitespaceRule, ERBClosingTagIndentRule])

      const result = linter.lint(dedent`
        - if admin
          p= user.name
      ` + "\n", { fileName: SLIM_FILE })

      expect(result.offenses).toEqual([])
    })

    test("offenses anchored only on synthesized tokens are dropped", () => {
      const linter = new Linter(Herb, [ElementEdgesRule])

      const slim = linter.lint(`p Hello\n`, { fileName: SLIM_FILE })
      const erb = linter.lint(`<p>Hello</p>\n`, { fileName: "show.html.erb" })

      expect(slim.offenses.map(offense => offense.message)).toEqual(["tag name"])
      expect(erb.offenses.map(offense => offense.message)).toEqual(["tag name", "close tag"])
    })

    test("source rules only run on Slim when they say so", () => {
      const linter = new Linter(Herb, [ERBSourceRule, AnyLanguageSourceRule])
      const result = linter.lint(`p Hello\n`, { fileName: SLIM_FILE })

      expect(result.offenses.map(offense => offense.rule)).toEqual(["test-any-language-source"])
    })

    test("lexer rules don't run on Slim", () => {
      const linter = new Linter(Herb, [TokenRule])

      expect(linter.lint(`p Hello\n`, { fileName: SLIM_FILE }).offenses).toEqual([])
      expect(linter.lint(`<p>Hello</p>\n`, { fileName: "show.html.erb" }).offenses).toHaveLength(1)
    })

    test("every built-in rule runs on a Slim template without throwing", () => {
      const linter = Linter.from(Herb, undefined, undefined, { all: true })

      const source = dedent`
        doctype html
        html
          head
            title = title
          body
            / herb:disable html-img-require-alt
            img src=avatar_url
            #main.card data-controller="card"
              - if admin
                p= user.name
              - else
                p Guest
              - items.each do |item|
                a href=item.url = item.title
              = render "shared/footer", locals: { year: 2026 }
              input type="checkbox" checked=true
              javascript:
                console.log(#{count})
      ` + "\n"

      expect(() => linter.lint(source, { fileName: SLIM_FILE, framework: "actionview" })).not.toThrow()
    })

    test("rule language declarations", () => {
      expect(ruleRunsOn(ERBRequireWhitespaceRule, "slim")).toBe(false)
      expect(ruleRunsOn(ERBRequireWhitespaceRule, "erb")).toBe(true)
      expect(ruleRunsOn(HTMLImgRequireAltRule, "slim")).toBe(true)

      for (const rule of [ERBNoByteOrderMarkRule, ERBRequireTrailingNewlineRule, ERBNoExtraNewLineRule, SourceIndentationRule, HerbDisableCommentOutOfDateRule]) {
        expect(ruleRunsOn(rule, "slim")).toBe(true)
      }

      expect(ruleAutofixesIn(SourceIndentationRule, "slim")).toBe(false)
      expect(ruleAutofixesIn(ERBRequireTrailingNewlineRule, "slim")).toBe(true)
      expect(ruleAutofixesIn(HTMLTagNameLowercaseRule, "slim")).toBe(false)
      expect(ruleAutofixesIn(HTMLTagNameLowercaseRule, "erb")).toBe(true)
    })

    test("no built-in parser rule claims a Slim-safe autofix", () => {
      const slimFixers = rules.filter(rule => rule.type !== "source" && ruleAutofixesIn(rule, "slim"))

      expect(slimFixers.map(rule => rule.ruleName)).toEqual([])
    })
  })

  describe("adapted rules", () => {
    test("html-boolean-attributes-no-value accepts a Ruby value, which is how Slim spells a boolean attribute", () => {
      const linter = new Linter(Herb, [HTMLBooleanAttributesNoValueRule])
      const source = `input type="checkbox" checked=user.terms? disabled="disabled"\n`

      const result = linter.lint(source, { fileName: SLIM_FILE })

      expect(result.offenses.map(offense => offense.message)).toEqual([
        "Boolean attribute `disabled` should not have a value. Use `disabled` instead of `disabled=\"disabled\"`.",
      ])
    })
  })

  describe("source rules", () => {
    test("erb-require-trailing-newline reports and fixes Slim files", () => {
      const linter = new Linter(Herb, [ERBRequireTrailingNewlineRule])
      const lintResult = linter.lint(`p Hello`, { fileName: SLIM_FILE })

      expect(lintResult.offenses.map(offense => offense.rule)).toEqual(["erb-require-trailing-newline"])
      expect(linter.autofix(`p Hello`, { fileName: SLIM_FILE }).source).toBe(`p Hello\n`)
    })

    test("erb-no-extra-newline reports and fixes Slim files", () => {
      const linter = new Linter(Herb, [ERBNoExtraNewLineRule])
      const source = `p One\n\n\n\n\np Two\n`

      expect(linter.lint(source, { fileName: SLIM_FILE }).offenses).toHaveLength(1)
      expect(linter.autofix(source, { fileName: SLIM_FILE }).source).toBe(`p One\n\n\np Two\n`)
    })

    test("source-indentation reports tabs in Slim but leaves them for the author to fix", () => {
      const linter = new Linter(Herb, [SourceIndentationRule])
      const source = `div\n\tp Hello\n`

      const lintResult = linter.lint(source, { fileName: SLIM_FILE })
      expect(lintResult.offenses.map(where)).toEqual(["2:0-2:1"])

      const autofixResult = linter.autofix(source, { fileName: SLIM_FILE })
      expect(autofixResult.source).toBe(source)
      expect(autofixResult.fixed).toEqual([])
      expect(autofixResult.unfixed.map(offense => offense.rule)).toEqual(["source-indentation"])
    })
  })

  describe("autofix", () => {
    test("never writes ERB into a Slim file", () => {
      const linter = new Linter(Herb, [HTMLTagNameLowercaseRule, HTMLBooleanAttributesNoValueRule])
      const source = `DIV\n  input type="checkbox" disabled="disabled"\n`

      const lintResult = linter.lint(source, { fileName: SLIM_FILE })
      expect(lintResult.offenses.length).toBeGreaterThan(0)

      const autofixResult = linter.autofix(source, { fileName: SLIM_FILE })

      expect(autofixResult.source).toBe(source)
      expect(autofixResult.fixed).toEqual([])
      expect(autofixResult.unfixed).toHaveLength(lintResult.offenses.length)
    })

    test("still fixes the same offenses in ERB", () => {
      const linter = new Linter(Herb, [HTMLTagNameLowercaseRule])
      const autofixResult = linter.autofix(`<DIV></DIV>\n`, { fileName: "show.html.erb" })

      expect(autofixResult.source).toBe(`<div></div>\n`)
    })

    test("reports parser rule offenses in Slim as not fixable", () => {
      const linter = new Linter(Herb, [HTMLTagNameLowercaseRule])
      const [offense] = linter.lint(`DIV\n`, { fileName: SLIM_FILE }).offenses

      expect(fixabilityFor(offense, HTMLTagNameLowercaseRule, "slim")).toEqual({ autocorrectable: false, unsafeAutocorrectable: false })
      expect(fixabilityFor(offense, HTMLTagNameLowercaseRule, "erb").autocorrectable).toBe(true)
      expect(fixabilityFor(offense, HTMLTagNameLowercaseRule).autocorrectable).toBe(true)
    })
  })

  describe("herb:disable comments", () => {
    test("parses a Slim code comment", () => {
      const parsed = parseHerbDisableLine(`  / herb:disable html-img-require-alt, html-iframe-has-title 2  `, "slim")

      expect(parsed?.match).toBe("/ herb:disable html-img-require-alt, html-iframe-has-title 2")
      expect(parsed?.ruleNames).toEqual(["html-img-require-alt"])
      expect(parsed?.fileScopedEntries.map(entry => [entry.name, entry.count])).toEqual([["html-iframe-has-title", 2]])
    })

    test("ignores Slim HTML comments and ERB comments in Slim", () => {
      expect(parseHerbDisableLine(`/! herb:disable html-img-require-alt`, "slim")).toBeNull()
      expect(parseHerbDisableLine(`<%# herb:disable html-img-require-alt %>`, "slim")).toBeNull()
      expect(parseHerbDisableLine(`p / herb:disable html-img-require-alt`, "slim")).toBeNull()
    })

    test("a Slim directive disables the next line", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule])

      const result = linter.lint(dedent`
        / herb:disable html-img-require-alt
        img src="a.png"
        img src="b.png"
      ` + "\n", { fileName: SLIM_FILE })

      expect(result.offenses.map(where)).toEqual(["3:0-3:3"])
      expect(result.ignored).toBe(1)
    })

    test("a Slim directive skips blank lines and other comments", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule, HTMLIframeHasTitleRule, HerbDisableCommentUnnecessaryRule])

      const result = linter.lint(dedent`
        div
          / herb:disable html-img-require-alt
          / herb:disable html-iframe-has-title

          img src="a.png"
      ` + "\n", { fileName: SLIM_FILE })

      expect(result.ignored).toBe(1)
      expect(result.offenses.map(offense => [offense.rule, where(offense)])).toEqual([
        ["herb-disable-comment-unnecessary", "3:2-3:38"],
      ])
    })

    test("a Slim directive with nothing to disable is reported as unnecessary", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule, HerbDisableCommentUnnecessaryRule])

      const result = linter.lint(dedent`
        / herb:disable html-img-require-alt
        img src="a.png" alt=""
      ` + "\n", { fileName: SLIM_FILE })

      expect(result.offenses.map(offense => [offense.rule, where(offense)])).toEqual([
        ["herb-disable-comment-unnecessary", "1:0-1:35"],
      ])
    })

    test("unknown rule names in a Slim directive are reported", () => {
      const linter = new Linter(Herb, [HerbDisableCommentValidRuleNameRule])
      const result = linter.lint(`/ herb:disable html-img-require-alts\nimg src="a.png"\n`, { fileName: SLIM_FILE })

      expect(result.offenses.map(offense => offense.rule)).toEqual(["herb-disable-comment-valid-rule-name"])
    })

    test("file-scoped counts in a Slim directive suppress offenses", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule, HerbDisableCommentOutOfDateRule])

      const result = linter.lint(dedent`
        / herb:disable html-img-require-alt 2
        img src="a.png"
        div
          img src="b.png"
      ` + "\n", { fileName: SLIM_FILE })

      expect(result.offenses).toEqual([])
      expect(result.counterSuppressed).toBe(2)
    })

    test("herb-disable-comment-out-of-date fixes the count inside the Slim comment", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule, HerbDisableCommentOutOfDateRule])
      const source = `/ herb:disable html-img-require-alt 3\nimg src="a.png"\nimg src="b.png"\n`

      const autofixResult = linter.autofix(source, { fileName: SLIM_FILE })

      expect(autofixResult.fixed.map(offense => offense.rule)).toEqual(["herb-disable-comment-out-of-date"])
      expect(autofixResult.source).toBe(`/ herb:disable html-img-require-alt 2\nimg src="a.png"\nimg src="b.png"\n`)
    })

    test("updateCounters rewrites and removes Slim counts", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule, HTMLIframeHasTitleRule])

      const source = dedent`
        / herb:disable html-img-require-alt 5
        img src="a.png"
        / herb:disable html-iframe-has-title 1
        p Hello
      ` + "\n"

      const updated = linter.updateCounters(source, { fileName: SLIM_FILE })

      expect(updated.rewritten).toBe(1)
      expect(updated.deleted).toBe(1)
      expect(updated.source).toBe(`/ herb:disable html-img-require-alt 1\nimg src="a.png"\np Hello\n`)
    })

    test("ERB directives keep applying to their own line", () => {
      const linter = new Linter(Herb, [HTMLImgRequireAltRule])

      const result = linter.lint(dedent`
        <%# herb:disable html-img-require-alt %>
        <img src="a.png"> <%# herb:disable html-img-require-alt %>
        <img src="b.png">
      ` + "\n", { fileName: "show.html.erb" })

      expect(result.offenses.map(where)).toEqual(["3:1-3:4"])
    })
  })

  test("context passed to rules carries the language", () => {
    let seen: Partial<LintContext> | undefined

    class SpyRule extends ParserRule {
      static ruleName = "test-spy"
      static introducedIn = this.version("unreleased")

      check(_result: ParseResult, context?: Partial<LintContext>): UnboundLintOffense[] {
        seen = context
        return []
      }
    }

    new Linter(Herb, [SpyRule]).lint(`p Hello\n`, { fileName: SLIM_FILE })

    expect(seen?.language).toBe("slim")
  })

  describe("project Slim settings", () => {
    const source = dedent`
      .actions~actions data-controller="dropdown"
        button~submit.btn class="btn-primary" data-controller="tooltip" data-controller="loading" Save
    ` + "\n"

    const config = Config.fromObject({
      slim: {
        shortcuts: { "#": { attr: "id" }, ".": { attr: "class" }, "~": { attr: "data-testid" } },
        merge_attrs: { class: " ", "data-controller": " " },
      },
    }, { projectPath: process.cwd() })

    test("custom shortcuts and merged attributes lint cleanly", () => {
      const linter = new Linter(Herb, [ParserNoErrorsRule, HTMLNoDuplicateAttributesRule], config)
      const result = linter.lint(source, { fileName: SLIM_FILE })

      expect(result.offenses.map(offense => `${offense.rule}: ${offense.message}`)).toEqual([])
    })

    test("the shortcut writes the configured attribute", () => {
      const linter = new Linter(Herb, [], config)
      const parseResult = linter["parseCache"].get(source, linter["templateParserOptions"]("slim"))
      const element = parseResult.value.children[0] as HTMLElementNode
      const names = element.open_tag!.children
        .filter(node => node.type === "AST_HTML_ATTRIBUTE_NODE")
        .map(node => (node as any).name.children[0].content)

      expect(names).toContain("data-testid")
    })
  })
})
