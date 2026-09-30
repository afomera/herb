import dedent from "dedent"

import { describe, test, expect, beforeAll } from "vitest"
import { Position, Range } from "vscode-languageserver-types"
import { TextDocument } from "vscode-languageserver-textdocument"
import { Herb } from "@herb-tools/node-wasm"

import { ParserService } from "../src/parser_service"
import { FoldingRangeProvider } from "../src/folding_range_provider"
import { DocumentSymbolProvider } from "../src/document_symbol_provider"
import { DocumentHighlightProvider } from "../src/document_highlight_provider"
import { SelectionRangeProvider } from "../src/selection_range_provider"
import { HoverProvider } from "../src/hover_provider"
import { DefinitionProvider } from "../src/definition_provider"
import { CompletionProvider } from "../src/completion_provider"
import { RewriteCodeActionProvider } from "../src/rewrite_code_action_provider"
import { ExtractCodeActionProvider } from "../src/extract_code_action_provider"
import { CommentProvider } from "../src/comment_provider"
import { OnTypeFormattingProvider } from "../src/on_type_formatting_provider"
import { InlayHintProvider } from "../src/inlay_hint_provider"
import { isERBDocument } from "../src/template_language"

const SOURCE = dedent`
  .card
    - if admin
      p = user.name
    - else
      p Guest
    = link_to "Edit", edit_user_path(user)
` + "\n"

function slimDocument(content = SOURCE, uri = "file:///app/views/users/show.html.slim", languageId = "slim") {
  return TextDocument.create(uri, languageId, 1, content)
}

describe("Slim documents", () => {
  let parserService: ParserService

  beforeAll(async () => {
    await Herb.load()
    parserService = new ParserService(Herb)
  })

  describe("parsing", () => {
    test("parses a .slim document as Slim", () => {
      const { document, diagnostics } = parserService.parseDocument(slimDocument())

      expect(diagnostics).toEqual([])
      expect(document.children[0].type).toBe("AST_HTML_ELEMENT_NODE")
    })

    test("parses by language id when the URI has no extension", () => {
      const { document } = parserService.parseDocument(slimDocument(SOURCE, "untitled:Untitled-1"))

      expect(document.children[0].type).toBe("AST_HTML_ELEMENT_NODE")
    })

    test("reports Slim parse errors at Slim positions", () => {
      const { diagnostics } = parserService.parseDocument(slimDocument("div\n    p One\n  p Two\n"))

      expect(diagnostics.length).toBeGreaterThan(0)
      expect(diagnostics[0].range.start.line).toBe(2)
    })

    test("passes the project's Slim settings to the parser", () => {
      const service = new ParserService(Herb)
      service.setConfig({ slim: { shortcuts: { "~": { attr: "data-testid" } }, merge_attrs: { class: " " } } })

      const result = service.parseContent("p~greeting Hello\n", undefined, "file:///show.html.slim")

      expect(result.errors).toEqual([])
      expect(JSON.stringify(result.value.toJSON())).toContain("data-testid")
    })
  })

  describe("features that read the tree", () => {
    test("folds indented blocks", () => {
      const ranges = new FoldingRangeProvider(parserService).getFoldingRanges(slimDocument())

      expect(ranges.map(range => range.startLine)).toContain(0)
    })

    test("lists document symbols", () => {
      const symbols = new DocumentSymbolProvider(parserService).getDocumentSymbols(slimDocument(), { framework: "actionview" })

      expect(symbols[0].name).toBe("div.card")
    })

    test("selection ranges start at the Slim source", () => {
      const [range] = new SelectionRangeProvider(parserService).getSelectionRanges(slimDocument(), [Position.create(2, 4)])

      expect(range.range.start.line).toBe(2)
    })

    test("never highlights a synthesized close tag", () => {
      const highlights = new DocumentHighlightProvider(parserService).getDocumentHighlights(slimDocument(), Position.create(2, 4))

      for (const highlight of highlights) {
        expect(highlight.range.start).not.toEqual(highlight.range.end)
      }
    })

    test("hovers Rails helpers", () => {
      const hover = new HoverProvider(parserService, "/tmp").getHover(slimDocument(), Position.create(5, 5), { framework: "actionview" })

      expect(JSON.stringify(hover)).toContain("link_to")
    })

    test("hover and definition don't throw anywhere in the document", () => {
      const document = slimDocument()
      const hover = new HoverProvider(parserService, "/tmp")
      const definition = new DefinitionProvider(parserService, () => false, () => null)

      for (let line = 0; line < document.lineCount; line++) {
        for (let character = 0; character < 40; character++) {
          const position = Position.create(line, character)

          expect(() => hover.getHover(document, position, { framework: "actionview" })).not.toThrow()
          expect(() => definition.getDefinition(document, position, { framework: "actionview" })).not.toThrow()
          expect(() => definition.getHover(document, position, { framework: "actionview" })).not.toThrow()
        }
      }
    })
  })

  describe("features that would write ERB", () => {
    const range = Range.create(0, 0, 2, 0)

    test("are off for Slim", () => {
      const document = slimDocument()

      expect(isERBDocument(document)).toBe(false)
      expect(new CompletionProvider(parserService).getCompletions(document, Position.create(2, 4))).toBeNull()
      expect(new RewriteCodeActionProvider(parserService).getCodeActions(document, range, { framework: "actionview" })).toEqual([])
      expect(new ExtractCodeActionProvider(parserService, { supportsResourceCreation: true, supportsExtractToPartialCommand: true }, () => false).getCodeActions(document, range, { framework: "actionview" })).toEqual([])
      expect(new CommentProvider(parserService).toggleLineComment(document, range)).toEqual([])
      expect(new CommentProvider(parserService).toggleBlockComment(document, range)).toEqual([])
      expect(new OnTypeFormattingProvider().getTextEdits(document, Position.create(1, 12), ">")).toEqual([])
      expect(new InlayHintProvider(parserService).getInlayHints(document, { minimumLines: 1 })).toEqual([])
    })

    test("extracting a partial explains why it can't", () => {
      const provider = new ExtractCodeActionProvider(parserService, { supportsResourceCreation: true, supportsExtractToPartialCommand: true }, () => false)

      expect(provider.extractToPartial(slimDocument(), range, "card")).toEqual({ error: "Extracting a partial is only supported in ERB templates." })
    })

    test("stay on for ERB", () => {
      const erb = TextDocument.create("file:///app/views/users/show.html.erb", "erb", 1, "<div>\n  <p>Hello</p>\n</div>\n")

      expect(isERBDocument(erb)).toBe(true)
      expect(new CommentProvider(parserService).toggleLineComment(erb, Range.create(1, 0, 1, 0)).length).toBeGreaterThan(0)
    })
  })
})
