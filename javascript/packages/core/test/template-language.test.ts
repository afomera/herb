import { describe, test, expect } from "vitest"

import { isSlimPath, languageForPath, languageForDocument, templateLanguageName, parserOptionsForPath, slimParserOptions, slimShortcutParserValue, resolveSlimTemplateOptions } from "../src/template-language.js"

describe("@herb-tools/core", () => {
  describe("languageForPath", () => {
    test("parses .slim and .html.slim files as Slim", () => {
      expect(languageForPath("app/views/users/show.html.slim")).toBe("slim")
      expect(languageForPath("app/views/users/_card.slim")).toBe("slim")
      expect(languageForPath("/abs/path/INDEX.HTML.SLIM")).toBe("slim")
    })

    test("parses file URIs by their extension", () => {
      expect(languageForPath("file:///app/views/users/show.html.slim")).toBe("slim")
      expect(languageForPath("file:///app/views/users/show.html.slim?version=2")).toBe("slim")
      expect(languageForPath("file:///app/views/users/show.html.erb")).toBe("erb")
    })

    test("parses everything else as ERB", () => {
      expect(languageForPath("app/views/users/show.html.erb")).toBe("erb")
      expect(languageForPath("app/views/users/show.html.herb")).toBe("erb")
      expect(languageForPath("public/index.html")).toBe("erb")
      expect(languageForPath("app/views/slim/show.html.erb")).toBe("erb")
      expect(languageForPath("app/views/users/show.slimmer")).toBe("erb")
      expect(languageForPath(undefined)).toBe("erb")
      expect(languageForPath(null)).toBe("erb")
      expect(languageForPath("")).toBe("erb")
    })
  })

  describe("isSlimPath", () => {
    test("matches only the .slim extension", () => {
      expect(isSlimPath("show.html.slim")).toBe(true)
      expect(isSlimPath("show.slim.erb")).toBe(false)
    })
  })

  describe("languageForDocument", () => {
    test("uses the slim language id", () => {
      expect(languageForDocument({ uri: "untitled:Untitled-1", languageId: "slim" })).toBe("slim")
    })

    test("falls back to the URI when the language id is not Slim", () => {
      expect(languageForDocument({ uri: "file:///show.html.slim", languageId: "plaintext" })).toBe("slim")
      expect(languageForDocument({ uri: "file:///show.html.erb", languageId: "erb" })).toBe("erb")
    })
  })

  test("templateLanguageName", () => {
    expect(templateLanguageName("slim")).toBe("Slim")
    expect(templateLanguageName("erb")).toBe("ERB")
  })

  describe("parserOptionsForPath", () => {
    test("keeps ERB files on ERB with the project's parser options", () => {
      expect(parserOptionsForPath("app/views/show.html.erb", { parserOptions: { erb_openers: ["graphql"] } })).toEqual({
        erb_openers: ["graphql"],
        language: "erb",
      })
    })

    test("parses Slim files as Slim with Slim's default settings", () => {
      expect(parserOptionsForPath("app/views/show.html.slim")).toEqual({
        language: "slim",
        slim_shortcuts: { "#": "id", ".": "class" },
        slim_merge_attrs: { class: " " },
      })
    })

    test("passes a project's Slim settings, replacing the defaults", () => {
      const options = parserOptionsForPath("app/views/show.html.slim", {
        parserOptions: { erb_openers: ["graphql"] },
        slim: {
          shortcuts: { "#": { attr: "id" }, ".": { attr: "class" }, "~": { attr: "data-testid" } },
          merge_attrs: { class: " ", "data-controller": " " },
        },
      })

      expect(options).toEqual({
        erb_openers: ["graphql"],
        language: "slim",
        slim_shortcuts: { "#": "id", ".": "class", "~": "data-testid" },
        slim_merge_attrs: { class: " ", "data-controller": " " },
      })
    })
  })

  describe("slim settings", () => {
    test("fills in Slim's defaults for whatever is left out", () => {
      expect(resolveSlimTemplateOptions({ shortcuts: { "~": { attr: "data-testid" } } })).toEqual({
        shortcuts: { "~": { attr: "data-testid" } },
        merge_attrs: { class: " " },
      })
    })

    test("flattens a shortcut into the parser's value", () => {
      expect(slimShortcutParserValue({ attr: "data-testid" })).toBe("data-testid")
      expect(slimShortcutParserValue({ attr: ["role", "aria-label"] })).toBe("role aria-label")
      expect(slimShortcutParserValue({ tag: "section", attr: "role" })).toBe("tag:section role")
      expect(slimShortcutParserValue({ tag: "input" })).toBe("tag:input")
    })

    test("slimParserOptions doesn't share the default maps", () => {
      const options = slimParserOptions() as Record<string, Record<string, string>>

      options.slim_merge_attrs.id = "-"

      expect(slimParserOptions()).toEqual({ slim_shortcuts: { "#": "id", ".": "class" }, slim_merge_attrs: { class: " " } })
    })
  })
})
