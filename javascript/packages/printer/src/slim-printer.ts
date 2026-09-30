import { isParseResult, isVoidElement } from "@herb-tools/core"

import { codeLines, dedent, erbCode, erbOpening, isERBOutput, isERBTag } from "./erb-tags.js"
import { diagnosticAt } from "./conversion-diagnostic.js"
import { SLIM_MERGE_ATTRS_OPTION_DEFAULT, SLIM_SHORTCUTS_OPTION_DEFAULT, parseSlimShortcutsOption } from "./slim-shortcuts.js"

import type * as Nodes from "@herb-tools/core"
import type { Node, ParseResult } from "@herb-tools/core"
import type { ConversionDiagnostic } from "./conversion-diagnostic.js"
import type { ParsedSlimShortcut, SlimMergeAttrsOption, SlimShortcutsOption } from "./slim-shortcuts.js"

export interface SlimPrinterOptions {
  /** Spaces per nesting level. Defaults to 2. */
  indentWidth?: number
  /** The shortcuts to print (`slim_shortcuts` encoding). Defaults to Slim's `#` => id, `.` => class. */
  shortcuts?: SlimShortcutsOption
  /** Attributes whose values are merged (`slim_merge_attrs`). Defaults to Slim's `{ class: " " }`. */
  mergeAttrs?: SlimMergeAttrsOption
  /** Parses HTML+ERB. Used for the content of conditional comments (`<!--[if IE]>...<![endif]-->`). */
  parse?: (source: string) => ParseResult
}

// Pieces of an element's content: formatting whitespace (a line break and the indentation after it) is a `break`.
type Piece =
  | { kind: "text", text: string, node: Node }
  | { kind: "output", node: Nodes.ERBContentNode }
  | { kind: "break", indent: number, lines: number }
  | { kind: "node", node: Node }

type Item =
  | { kind: "node", node: Node }
  | { kind: "space", text: string, node: Node }
  | { kind: "text", lines: TextLine[], node: Node }

type TextLine = { pieces: Piece[], indent: number, blankBefore: number }

const WHITESPACE_PRESERVING = new Set(["pre", "textarea"])
const EMBEDDED = new Map([["script", "javascript:"], ["style", "css:"]])

// Temple::HTML::Fast doctypes (:html format, plus the :xhtml ones)
const DOCTYPES: Record<string, string> = {
  "html": "html",
  'html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"': "strict",
  'html PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN" "http://www.w3.org/TR/html4/frameset.dtd"': "frameset",
  'html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd"': "transitional",
  'html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"': "1.1",
  'html PUBLIC "-//WAPFORUM//DTD XHTML Mobile 1.2//EN" "http://www.openmobilealliance.org/tech/DTD/xhtml-mobile12.dtd"': "mobile",
  'html PUBLIC "-//W3C//DTD XHTML Basic 1.1//EN" "http://www.w3.org/TR/xhtml-basic/xhtml-basic11.dtd"': "basic",
  'svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"': "svg",
}

const SHORTCUT_VALUE = /^(?:[\p{L}\p{M}\p{N}_-]|\/\d+|:[\p{L}\p{M}\p{N}_-]+)+$/u

const SLIM_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }

function escapeSlim(text: string): string {
  return text.replace(/[&<>"']/g, character => SLIM_ESCAPES[character])
}

function unescapeSlim(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity as string]!)
}

// `#{` in static Slim text or quoted attribute values would start an interpolation.
function escapeInterpolation(text: string): string {
  return text.replace(/#\{/g, "\\#{")
}

function bracesBalanced(code: string): boolean {
  let depth = 0

  for (const character of code) {
    if (character === "{") depth++
    if (character === "}" && --depth < 0) return false
  }

  return depth === 0
}

/** Ruby code that Slim reads as one attribute value (`attr=code`): no whitespace outside brackets. */
function isSimpleCode(code: string): boolean {
  if (code.length === 0 || /^["'%]/.test(code) || /[,\\]$/.test(code)) return false
  if (["true", "false", "nil"].includes(code)) return false

  let depth = 0
  let quote: string | null = null

  for (let index = 0; index < code.length; index++) {
    const character = code[index]

    if (quote) {
      if (character === "\\") index++
      else if (character === quote) quote = null
      continue
    }

    if (character === '"' || character === "'") quote = character
    else if ("([{".includes(character)) depth++
    else if (")]}".includes(character)) {
      if (--depth < 0) return false
    } else if (/\s/.test(character) && depth === 0) return false
  }

  return depth === 0 && quote === null
}

/**
 * Prints a Herb HTML+ERB syntax tree as idiomatic Slim: `.card#main` shortcuts, `=` / `==` / `-` lines,
 * implied `end`s with `elsif` / `else` / `when` as siblings, `attr=code` and `attr="text #{code}"` attributes,
 * `|` text blocks, `/!` comments and `javascript:` / `css:` blocks.
 *
 * Whitespace that contains a line break is formatting (Slim doesn't render whitespace between lines), except
 * the spaces before the line break, which are kept (`'` text or `>` / `<` markers). Constructs that have no Slim
 * form (ERB control flow inside attribute values or open tags, a stray `<% end %>`, ...) are reported in
 * `errors` and printed as a `/ herb:` comment holding the original ERB. Places where the Slim renders
 * differently from the ERB are reported in `warnings`.
 */
export class SlimPrinter {
  readonly errors: ConversionDiagnostic[] = []
  readonly warnings: ConversionDiagnostic[] = []

  private readonly indentWidth: number
  private readonly shortcuts: ParsedSlimShortcut[]
  private readonly mergeAttrs: SlimMergeAttrsOption
  private readonly parse?: (source: string) => ParseResult

  static print(input: Node | ParseResult, options: SlimPrinterOptions = {}): string {
    return new SlimPrinter(options).print(input)
  }

  constructor(options: SlimPrinterOptions = {}) {
    this.indentWidth = options.indentWidth ?? 2
    this.shortcuts = parseSlimShortcutsOption(options.shortcuts ?? SLIM_SHORTCUTS_OPTION_DEFAULT)
    this.mergeAttrs = options.mergeAttrs ?? SLIM_MERGE_ATTRS_OPTION_DEFAULT
    this.parse = options.parse
  }

  print(input: Node | ParseResult): string {
    const node = isParseResult(input) ? input.value : input
    const children = node.type === "AST_DOCUMENT_NODE" ? (node as Nodes.DocumentNode).children : [node]
    const lines = this.block(children, 0)

    return lines.length > 0 ? lines.join("\n") + "\n" : ""
  }

  private indent(depth: number): string {
    return " ".repeat(depth * this.indentWidth)
  }

  private unsupported(node: Node, message: string, depth: number): string[] {
    this.errors.push(diagnosticAt(node, "unsupported-erb", message))

    const source = new ReadableSource(node).text()

    return [this.indent(depth) + "/ herb: no Slim form for: " + source.replace(/\s*\n\s*/g, " ")]
  }

  // --- content --------------------------------------------------------------------------------------------------

  private pieces(nodes: Node[]): Piece[] {
    const pieces: Piece[] = []

    const pushText = (text: string, node: Node) => {
      // Whitespace runs with a line break: the spaces before the break are content, the rest is formatting.
      const pattern = /[ \t]*(\r?\n[ \t\r\n]*)/g
      let last = 0
      let match: RegExpExecArray | null

      while ((match = pattern.exec(text))) {
        const pre = match[0].slice(0, match[0].length - match[1].length)
        const content = text.slice(last, match.index) + pre

        if (content.length > 0) pieces.push({ kind: "text", text: content, node })

        const newlines = (match[1].match(/\n/g) ?? []).length
        const indent = match[1].slice(match[1].lastIndexOf("\n") + 1).replace(/\r/g, "").length

        pieces.push({ kind: "break", indent, lines: newlines })
        last = match.index + match[0].length
      }

      if (last < text.length) pieces.push({ kind: "text", text: text.slice(last), node })
    }

    for (const node of nodes) {
      if (node.type === "AST_HTML_TEXT_NODE" || node.type === "AST_LITERAL_NODE") {
        pushText((node as Nodes.HTMLTextNode).content, node)
      } else if (node.type === "AST_WHITESPACE_NODE") {
        pushText((node as Nodes.WhitespaceNode).value?.value ?? " ", node)
      } else if (isERBOutput(node) && !erbCode(node).includes("\n")) {
        pieces.push({ kind: "output", node: node as Nodes.ERBContentNode })
      } else if (node.type === "AST_ERB_CONTENT_NODE" && erbOpening(node as Nodes.ERBContentNode) === "<%%") {
        // `<%% x %>` renders a literal `<% x %>`
        pieces.push({ kind: "text", text: "<%" + erbCode(node as Nodes.ERBContentNode) + "%>", node })
      } else {
        pieces.push({ kind: "node", node })
      }
    }

    // merge adjacent text pieces
    return pieces.reduce<Piece[]>((merged, piece) => {
      const previous = merged[merged.length - 1]

      if (piece.kind === "text" && previous?.kind === "text") {
        merged[merged.length - 1] = { ...previous, text: previous.text + piece.text }
      } else {
        merged.push(piece)
      }

      return merged
    }, [])
  }

  private items(nodes: Node[]): Item[] {
    const items: Item[] = []
    let segment: Piece[] = []

    const flush = () => {
      let firstIndent = -1

      while (segment[0]?.kind === "break") {
        firstIndent = segment[0].indent
        segment.shift()
      }

      while (segment[segment.length - 1]?.kind === "break") segment.pop()

      const content = segment.filter(piece => piece.kind !== "break") as Exclude<Piece, { kind: "break" }>[]

      if (content.length === 0) {
        segment = []
        return
      }

      if (content.every(piece => piece.kind === "text" && piece.text.trim() === "")) {
        items.push({ kind: "space", text: content.map(piece => (piece as { text: string }).text).join(""), node: content[0].node })
        segment = []
        return
      }

      let lines: TextLine[] = []
      let current: TextLine = { pieces: [], indent: firstIndent, blankBefore: 0 }

      for (const piece of segment) {
        if (piece.kind === "break") {
          lines.push(current)
          current = { pieces: [], indent: piece.indent, blankBefore: piece.lines - 1 }
        } else {
          current.pieces.push(piece)
        }
      }

      lines.push(current)

      // Whitespace-only first and last lines (spaces before a line break) belong to the neighbouring items.
      const isBlank = (line: TextLine) => line.pieces.every(piece => piece.kind === "text" && piece.text.trim() === "")
      const spaceOf = (line: TextLine): Item => ({ kind: "space", text: line.pieces.map(piece => (piece as { text: string }).text).join(""), node: content[0].node })
      let trailing: Item | null = null

      if (lines.length > 1 && isBlank(lines[0])) {
        items.push(spaceOf(lines[0]))
        lines = lines.slice(1)
      }

      if (lines.length > 1 && isBlank(lines[lines.length - 1])) {
        trailing = spaceOf(lines[lines.length - 1])
        lines = lines.slice(0, -1)
      }

      items.push({ kind: "text", lines, node: content[0].node })
      if (trailing) items.push(trailing)
      segment = []
    }

    for (const piece of this.pieces(nodes)) {
      if (piece.kind === "node") {
        flush()
        items.push({ kind: "node", node: piece.node })
      } else {
        segment.push(piece)
      }
    }

    flush()

    return items
  }

  private block(nodes: Node[], depth: number): string[] {
    const items = this.items(nodes)
    const lines: string[] = []

    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const previous = items[index - 1]
      const next = items[index + 1]

      if (item.kind === "space") {
        // attached to the neighbouring elements as `>` / `<` markers, or to neighbouring text; the rest as bare
        // `'` lines (each renders one space)
        if (next?.kind === "text" || previous?.kind === "text") continue

        const count = item.text.length - (this.isElement(previous) ? 1 : 0) - (this.isElement(next) && item.text.length > (this.isElement(previous) ? 1 : 0) ? 1 : 0)

        for (let space = 0; space < count; space++) lines.push(this.indent(depth) + "'")
        continue
      }

      if (item.kind === "text") {
        const leading = previous?.kind === "space" ? previous.text : ""
        const trailing = next?.kind === "space" ? next.text : ""

        lines.push(...this.textLines(item, depth, leading, trailing))
        continue
      }

      const node = item.node

      if (node.type === "AST_HTML_ELEMENT_NODE") {
        // `<` takes a space the element before hasn't taken with its `>`
        const leading = previous?.kind === "space" && items[index - 2]?.kind !== "text" &&
          previous.text.length > (this.isElement(items[index - 2]) ? 1 : 0)
        const trailing = next?.kind === "space" && items[index + 2]?.kind !== "text"

        lines.push(...this.element(node as Nodes.HTMLElementNode, depth, leading, trailing))
        continue
      }

      lines.push(...this.nodeLines(node, depth))
    }

    return lines
  }

  private isElement(item: Item | undefined): boolean {
    return item?.kind === "node" && item.node.type === "AST_HTML_ELEMENT_NODE"
  }

  // A text item: `| text` (or `' text` for one trailing space), `= code` for a lone output, `=<`/`=>` markers.
  private textLines(item: Extract<Item, { kind: "text" }>, depth: number, leading: string, trailing: string): string[] {
    const indent = this.indent(depth)
    const lines = item.lines.map(line => ({ ...line, pieces: [...line.pieces] }))

    if (leading) lines[0].pieces.unshift({ kind: "text", text: leading, node: item.node })
    if (trailing) lines[lines.length - 1].pieces.push({ kind: "text", text: trailing, node: item.node })

    // a lone output: `= code`, with `=<` / `=>` for the whitespace around it
    if (lines.length === 1) {
      const content = lines[0].pieces
      const outputs = content.filter(piece => piece.kind === "output")
      const texts = content.filter(piece => piece.kind === "text")

      if (outputs.length === 1 && texts.every(piece => (piece as { text: string }).text.trim() === "")) {
        const outputIndex = content.indexOf(outputs[0])
        const before = content.slice(0, outputIndex).length > 0
        const after = content.slice(outputIndex + 1).length > 0
        const output = outputs[0] as { node: Nodes.ERBContentNode }
        const raw = erbOpening(output.node) === "<%=="

        return [indent + (raw ? "==" : "=") + (before ? "<" : "") + (after ? ">" : "") + " " + erbCode(output.node).trim()]
      }
    }

    // outputs that can't be interpolated go on their own `=` lines
    const interpolatable = lines.every(line => line.pieces.every(piece => piece.kind !== "output" || this.interpolation(piece.node) !== null))

    if (!interpolatable) {
      return lines.flatMap(line => line.pieces.map(piece => {
        if (piece.kind === "output") {
          return indent + (erbOpening(piece.node) === "<%==" ? "== " : "= ") + erbCode(piece.node).trim()
        }

        return this.pipeLine(indent, escapeInterpolation((piece as { text: string }).text))
      }))
    }

    const texts = lines.map(line => line.pieces.map(piece => (piece.kind === "output" ? this.interpolation(piece.node)! : escapeInterpolation((piece as { text: string }).text))).join(""))

    if (texts.length === 1) return [this.pipeLine(indent, texts[0])]

    const firstPiece = lines[0].pieces[0]
    const base = lines[0].indent >= 0 ? lines[0].indent
      : firstPiece?.kind === "text" && firstPiece.node.location ? firstPiece.node.location.start.column
      : Math.min(...lines.slice(1).map(line => line.indent))
    const output = [indent + "| " + texts[0]]

    for (let index = 1; index < texts.length; index++) {
      for (let blank = 0; blank < lines[index].blankBefore; blank++) output.push("")

      const extra = Math.max(0, lines[index].indent - base)
      output.push(indent + "  " + " ".repeat(extra) + texts[index])
    }

    return output
  }

  private pipeLine(indent: string, text: string): string {
    if (/[^ ] $/.test(text)) return indent + "' " + text.slice(0, -1)
    if (text === " ") return indent + "'"

    return indent + "| " + text
  }

  private interpolation(node: Node): string | null {
    const code = erbCode(node as Nodes.ERBContentNode).trim()
    const raw = erbOpening(node as Nodes.ERBContentNode) === "<%=="

    if (!bracesBalanced(code) || code.includes("\n")) return null

    const padded = code.startsWith("{") || code.endsWith("}") ? ` ${code} ` : code

    return raw ? `#{{${padded}}}` : `#{${padded}}`
  }

  // --- elements -------------------------------------------------------------------------------------------------

  private element(node: Nodes.HTMLElementNode, depth: number, leadingSpace: boolean, trailingSpace: boolean): string[] {
    const indent = this.indent(depth)
    const name = node.tag_name?.value ?? "div"

    if (!node.open_tag || node.open_tag.type !== "AST_HTML_OPEN_TAG_NODE") {
      return this.unsupported(node, "Elements whose open tag isn't plain HTML (conditional or ActionView open tags) have no Slim form.", depth)
    }

    const markers = (leadingSpace ? "<" : "") + (trailingSpace ? ">" : "")
    const head = this.head(node.open_tag as Nodes.HTMLOpenTagNode, name, markers)
    const open = node.open_tag as Nodes.HTMLOpenTagNode
    const hasAttributes = open.children.some(child => child.type !== "AST_WHITESPACE_NODE")
    const lowerName = name.toLowerCase()

    if (node.is_void || isVoidElement(name) || !node.close_tag) {
      return [indent + head + (!isVoidElement(name) && open.tag_closing?.value === "/>" ? "/" : "")]
    }

    const body = node.body

    if (EMBEDDED.has(lowerName)) return this.embedded(node, head, EMBEDDED.get(lowerName)!, hasAttributes, depth)
    if (WHITESPACE_PRESERVING.has(lowerName)) return this.preformatted(node, head, depth)

    const pieces = this.pieces(body)
    const inline = this.inlineText(pieces)

    if (inline !== null) return [indent + head + " " + inline]

    const items = this.items(body)

    if (items.length === 0) return [indent + head]

    if (items.length === 1 && items[0].kind === "text" && items[0].lines.length === 1) {
      const content = items[0].lines[0].pieces

      if (content.length === 1 && content[0].kind === "output") {
        const output = content[0].node
        return [indent + head + (erbOpening(output) === "<%==" ? " == " : " = ") + erbCode(output).trim()]
      }
    }

    // `li: a href="/" Home`, unless the head ends in Ruby code, which would take the `:`
    const nestable = !hasAttributes || /["')\]]$/.test(head)

    if (nestable && items.length === 1 && items[0].kind === "node" && items[0].node.type === "AST_HTML_ELEMENT_NODE") {
      const child = this.element(items[0].node as Nodes.HTMLElementNode, 0, false, false)

      if (child.length === 1 && !child[0].startsWith("/ herb:")) return [indent + head + ": " + child[0]]
    }

    return [indent + head, ...this.block(body, depth + 1)]
  }

  // `tag text` when the content is text (with ERB output and inline HTML) without line breaks.
  private inlineText(pieces: Piece[]): string | null {
    if (pieces.length === 0 || pieces.some(piece => piece.kind === "break")) return null
    if (!pieces.some(piece => piece.kind === "text" && piece.text.trim() !== "")) return null

    let text = ""

    for (const piece of pieces) {
      if (piece.kind === "text") {
        text += escapeInterpolation(piece.text)
      } else if (piece.kind === "output") {
        const interpolation = this.interpolation(piece.node)
        if (interpolation === null) return null
        text += interpolation
      } else if (piece.kind === "node") {
        const html = this.inlineHTML(piece.node)
        if (html === null) return null
        text += html
      }
    }

    if (/\s$/.test(text) || text.includes("\n")) return null

    // Text that Slim would read as something else after the tag: attributes, `:`, `=`, `/`, a splat, a wrapper.
    if (/^[:=/*([{]/.test(text) || /^[^\s"'<>/=()[\]{}]+\s*=/.test(text) || /^\s/.test(text) && /^\s+[:=/*([{]/.test(text)) return null

    return text
  }

  // An element written as HTML inside Slim text: `p Hello <b>#{name}</b>`.
  private inlineHTML(node: Node): string | null {
    if (node.type !== "AST_HTML_ELEMENT_NODE") return null

    const element = node as Nodes.HTMLElementNode
    if (!element.open_tag || element.open_tag.type !== "AST_HTML_OPEN_TAG_NODE") return null

    const open = element.open_tag as Nodes.HTMLOpenTagNode
    const name = element.tag_name?.value ?? ""
    let html = `<${name}`

    for (const child of open.children) {
      if (child.type === "AST_WHITESPACE_NODE") continue
      if (child.type !== "AST_HTML_ATTRIBUTE_NODE") return null

      const attribute = child as Nodes.HTMLAttributeNode
      const attributeName = this.attributeName(attribute)
      if (attributeName === null) return null

      html += " " + attributeName

      if (attribute.value) {
        const quote = attribute.value.open_quote?.value === "'" ? "'" : '"'
        let value = ""

        for (const part of attribute.value.children) {
          if (part.type === "AST_LITERAL_NODE") value += escapeInterpolation((part as Nodes.LiteralNode).content)
          else if (isERBOutput(part) && this.interpolation(part) !== null) value += this.interpolation(part)
          else return null
        }

        html += `=${quote}${value}${quote}`
      }
    }

    html += open.tag_closing?.value === "/>" ? " />" : ">"

    if (element.is_void || !element.close_tag) return html

    for (const piece of this.pieces(element.body)) {
      if (piece.kind === "break") return null
      if (piece.kind === "text") html += escapeInterpolation(piece.text)
      else if (piece.kind === "output") {
        const interpolation = this.interpolation(piece.node)
        if (interpolation === null) return null
        html += interpolation
      } else if (piece.kind === "node") {
        const inner = this.inlineHTML(piece.node)
        if (inner === null) return null
        html += inner
      }
    }

    return html + `</${name}>`
  }

  // `javascript:` / `css:` for plain <script> / <style>, `script attrs` with a `|` block otherwise.
  private embedded(node: Nodes.HTMLElementNode, head: string, engine: string, hasAttributes: boolean, depth: number): string[] {
    const indent = this.indent(depth)
    let content = ""

    for (const child of node.body) {
      if (child.type === "AST_LITERAL_NODE" || child.type === "AST_HTML_TEXT_NODE") {
        content += escapeInterpolation((child as Nodes.LiteralNode).content)
      } else if (isERBOutput(child) && this.interpolation(child) !== null) {
        content += this.interpolation(child)
      } else {
        return this.unsupported(node, `ERB control flow inside <${node.tag_name?.value}> has no Slim form.`, depth)
      }
    }

    const lines = dedent(content.replace(/\r\n/g, "\n").split("\n"))

    while (lines.length > 0 && lines[0].trim() === "") lines.shift()
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()

    if (lines.length === 0) return [indent + head]

    const inner = this.indent(depth + 1)

    if (!hasAttributes) {
      return [indent + engine, ...lines.map(line => (line.trim() === "" ? "" : inner + line.trimEnd()))]
    }

    return [indent + head, inner + "| " + lines[0], ...lines.slice(1).map(line => (line.trim() === "" ? "" : inner + "  " + line.trimEnd()))]
  }

  private preformatted(node: Nodes.HTMLElementNode, head: string, depth: number): string[] {
    const indent = this.indent(depth)
    let content = ""

    for (const child of node.body) {
      if (child.type === "AST_HTML_TEXT_NODE" || child.type === "AST_LITERAL_NODE") content += escapeInterpolation((child as Nodes.HTMLTextNode).content)
      else if (isERBOutput(child) && this.interpolation(child) !== null) content += this.interpolation(child)
      else return [indent + head, ...this.block(node.body, depth + 1)]
    }

    if (content.length === 0) return [indent + head]

    const lines = content.split("\n")

    if (lines.length === 1 && !/^[\s:=/*([{]/.test(content) && !/\s$/.test(content)) return [indent + head + " " + content]

    const inner = this.indent(depth + 1)

    return [indent + head, inner + "| " + lines[0], ...lines.slice(1).map(line => inner + "  " + line)]
  }

  // --- attributes -----------------------------------------------------------------------------------------------

  private attributeName(node: Nodes.HTMLAttributeNode): string | null {
    const children = node.name?.children ?? []
    if (!children.every(child => child.type === "AST_LITERAL_NODE")) return null

    return children.map(child => (child as Nodes.LiteralNode).content).join("")
  }

  private findShortcut(name: string): ParsedSlimShortcut | null {
    return this.shortcuts.find(shortcut => shortcut.attributes.length === 1 && shortcut.attributes[0] === name && shortcut.additional.length === 0) ?? null
  }

  private head(open: Nodes.HTMLOpenTagNode, name: string, markers: string): string {
    const children = open.children.filter(child => child.type !== "AST_WHITESPACE_NODE")
    let shortcuts = ""
    let firstShortcut: ParsedSlimShortcut | null = null
    let index = 0

    // the leading id/class-like attributes with static values become shortcuts (`.card#main`)
    for (; index < children.length; index++) {
      const child = children[index]
      if (child.type !== "AST_HTML_ATTRIBUTE_NODE") break

      const attribute = child as Nodes.HTMLAttributeNode
      const attributeName = this.attributeName(attribute)
      const shortcut = attributeName ? this.findShortcut(attributeName) : null

      if (!attributeName || !shortcut || !attribute.value) break

      const parts = attribute.value.children
      const separator = this.mergeAttrs[attributeName]
      const staticEnd = parts.findIndex(part => part.type !== "AST_LITERAL_NODE")
      const staticText = parts.slice(0, staticEnd === -1 ? parts.length : staticEnd).map(part => (part as Nodes.LiteralNode).content).join("")
      const remainder = staticEnd === -1 ? [] : parts.slice(staticEnd)

      let values: string[]
      let rest = ""

      if (separator !== undefined && separator.length > 0) {
        const words = staticText.split(separator)

        if (remainder.length > 0) rest = words.pop()!
        values = words
      } else {
        if (remainder.length > 0) break
        values = [staticText]
      }

      if (values.length === 0 || !values.every(value => SHORTCUT_VALUE.test(value))) break

      for (const value of values) shortcuts += shortcut.key + value
      firstShortcut ??= shortcut

      if (remainder.length > 0 || rest.length > 0) {
        // the rest of a merged attribute (`.a class=b`), right after its shortcuts
        const restParts: Node[] = []
        if (rest.length > 0) restParts.push({ type: "AST_LITERAL_NODE", content: rest, location: parts[0].location } as unknown as Node)
        restParts.push(...remainder)

        const printed = this.attributeValue(attributeName, restParts, attribute)
        const tail = children.slice(index + 1).map(other => this.attributeOrSplat(other)).filter((value): value is string => value !== null)

        return this.assemble(name, shortcuts, firstShortcut, markers, [printed, ...tail].filter((value): value is string => value !== null), children.slice(index + 1))
      }
    }

    const attributes = children.slice(index).map(child => this.attributeOrSplat(child)).filter((value): value is string => value !== null)

    return this.assemble(name, shortcuts, firstShortcut, markers, attributes, children.slice(index))
  }

  // The tag name as Slim reads it at the start of a line: a tag-only shortcut for it (`sec` => section), since a
  // shortcut key that starts the name would be read as the shortcut.
  private tagName(name: string): string {
    const tagOnly = this.shortcuts.find(shortcut => shortcut.attributes.length === 0 && shortcut.tag === name)
    if (tagOnly) return tagOnly.key

    const clash = this.shortcuts.find(shortcut => name.startsWith(shortcut.key))
    if (clash) {
      this.errors.push({ kind: "unsupported-erb", message: `The tag name \`${name}\` starts with the shortcut \`${clash.key}\`, so Slim can't write it.`, line: 1, column: 0 })
    }

    return name
  }

  private assemble(name: string, shortcuts: string, firstShortcut: ParsedSlimShortcut | null, markers: string, attributes: string[], nodes: Node[]): string {
    const omitName = firstShortcut !== null && (firstShortcut.tag ?? "div") === name
    const boolean = nodes.some(node => node.type === "AST_HTML_ATTRIBUTE_NODE" && !(node as Nodes.HTMLAttributeNode).value && this.attributeName(node as Nodes.HTMLAttributeNode) !== null)
    let head = (omitName ? "" : this.tagName(name)) + shortcuts + markers

    if (attributes.length === 0) return head

    head += boolean ? `(${attributes.join(" ")})` : " " + attributes.join(" ")

    return head
  }

  private attributeOrSplat(node: Node): string | null {
    if (node.type === "AST_HTML_ATTRIBUTE_NODE") {
      const attribute = node as Nodes.HTMLAttributeNode
      const name = this.attributeName(attribute)

      // `<div <%= tag.attributes(**x) %>>`: the ERB parser reads ERB in an open tag as a value-less attribute name
      const nameChildren = attribute.name?.children ?? []
      if (name === null && !attribute.value && nameChildren.length === 1 && isERBOutput(nameChildren[0])) {
        return this.splat(erbCode(nameChildren[0]).trim(), nameChildren[0])
      }

      if (name === null) {
        this.errors.push(diagnosticAt(node, "unsupported-erb", "ERB in an attribute name has no Slim form; the attribute was dropped."))
        return null
      }

      if (!attribute.value) return name

      return this.attributeValue(name, attribute.value.children, attribute)
    }

    if (node.type === "AST_RUBY_HTML_ATTRIBUTES_SPLAT_NODE") {
      return this.splat((node as Nodes.RubyHTMLAttributesSplatNode).content, node)
    }

    if (isERBOutput(node)) {
      return this.splat(erbCode(node).trim(), node)
    }

    this.errors.push(diagnosticAt(node, "unsupported-erb", "ERB control flow inside an open tag has no Slim form; it was dropped."))

    return null
  }

  // `tag.attributes(**x)` => `*x`, `tag.attributes(data: x)` => `data=x`
  private splat(code: string, node: Node): string | null {
    const splat = code.match(/^tag\.attributes\(\*\*(.*)\)$/s)
    if (splat && isSimpleCode(splat[1])) return `*${splat[1]}`

    const prefixed = code.match(/^tag\.attributes\((data|aria): (.*)\)$/s)
    if (prefixed && isSimpleCode(prefixed[2])) return `${prefixed[1]}=${prefixed[2]}`

    this.errors.push(diagnosticAt(node, "unsupported-erb", `\`<%= ${code} %>\` inside an open tag has no Slim form (only \`tag.attributes(**hash)\` does); it was dropped.`))

    return null
  }

  private attributeValue(name: string, parts: Node[], node: Node): string | null {
    const texts = parts.filter(part => part.type === "AST_LITERAL_NODE") as Nodes.LiteralNode[]
    const outputs = parts.filter(part => isERBOutput(part))

    if (texts.length + outputs.length !== parts.length) {
      this.errors.push(diagnosticAt(node, "unsupported-erb", `ERB control flow in the value of \`${name}\` has no Slim form; the attribute was dropped.`))
      return null
    }

    // `attr=code` / `attr==code`
    if (outputs.length === 1 && texts.every(text => text.content === "")) {
      const output = outputs[0]
      const code = erbCode(output).trim()
      const raw = erbOpening(output) === "<%=="

      const continued = code.includes("\n") && code.split("\n").slice(0, -1).every(line => /[,\\]\s*$/.test(line))

      if (isSimpleCode(code) || (continued && isSimpleCode(code.replace(/[,\\]?\s*\n\s*/g, "")))) {
        this.warnings.push(
          diagnosticAt(
            output,
            name in this.mergeAttrs ? "dynamic-class" : "dynamic-attribute",
            name in this.mergeAttrs
              ? `\`${name}=${code}\`: Slim flattens Array values and omits the attribute when the value is empty; the ERB rendered the value's \`to_s\`.`
              : `\`${name}=${code}\`: Slim omits the attribute when the value is nil or false and renders a bare \`${name}\` when it is true; the ERB always rendered \`${name}="…"\`.`,
          ),
        )

        return `${name}${raw ? "==" : "="}${continued ? erbCode(output).replace(/^\s+|\s+$/g, "") : code}`
      }
    }

    // a quoted value: static text escaped like Slim escapes it, `#{code}` for ERB output
    const decoded = texts.every(text => escapeSlim(unescapeSlim(text.content)) === text.content)
    let value = ""

    for (const part of parts) {
      if (part.type === "AST_LITERAL_NODE") {
        const content = (part as Nodes.LiteralNode).content
        value += escapeInterpolation(decoded ? unescapeSlim(content) : content)
      } else {
        const interpolation = this.interpolation(part)

        if (interpolation === null) {
          this.errors.push(diagnosticAt(part, "unsupported-erb", `\`<%= ${erbCode(part).trim()} %>\` in \`${name}\` can't be written as a Slim interpolation; the attribute was dropped.`))
          return null
        }

        value += interpolation
      }
    }

    // Slim ends a quoted value at the quote character outside of `#{}`, so only the static text matters
    const staticText = texts.map(text => (decoded ? unescapeSlim(text.content) : text.content)).join("")
    let quote = '"'

    if (staticText.includes('"')) {
      if (!staticText.includes("'")) {
        quote = "'"
      } else {
        // both quotes: keep the static text escaped
        const escaped = parts.map(part => (part.type === "AST_LITERAL_NODE" ? escapeInterpolation((part as Nodes.LiteralNode).content) : this.interpolation(part))).join("")
        return `${name}=="${escaped}"`
      }
    }

    return `${name}${decoded ? "=" : "=="}${quote}${value}${quote}`
  }

  // --- other nodes ----------------------------------------------------------------------------------------------

  private nodeLines(node: Node, depth: number): string[] {
    const indent = this.indent(depth)

    switch (node.type) {
      case "AST_ERB_IF_NODE": {
        const ifNode = node as Nodes.ERBIfNode
        const lines = [...this.codeLine(this.indicator(ifNode), ifNode, depth), ...this.block(ifNode.statements, depth + 1)]
        let subsequent: Nodes.ERBIfNode | Nodes.ERBElseNode | null = ifNode.subsequent

        while (subsequent) {
          lines.push(...this.codeLine("-", subsequent, depth), ...this.block(subsequent.statements, depth + 1))
          subsequent = subsequent.type === "AST_ERB_IF_NODE" ? (subsequent as Nodes.ERBIfNode).subsequent : null
        }

        return lines
      }
      case "AST_ERB_UNLESS_NODE": {
        const unless = node as Nodes.ERBUnlessNode
        return [
          ...this.codeLine(this.indicator(unless), unless, depth),
          ...this.block(unless.statements, depth + 1),
          ...(unless.else_clause ? this.clause(unless.else_clause, depth) : []),
        ]
      }
      case "AST_ERB_CASE_NODE":
      case "AST_ERB_CASE_MATCH_NODE": {
        const kase = node as Nodes.ERBCaseNode
        const between = kase.children.filter(child => !((child.type === "AST_HTML_TEXT_NODE") && (child as Nodes.HTMLTextNode).content.trim() === ""))

        return [
          ...this.codeLine(this.indicator(kase), kase, depth),
          ...this.block(between, depth + 1),
          ...kase.conditions.flatMap(condition => this.clause(condition as Nodes.ERBWhenNode, depth)),
          ...(kase.else_clause ? this.clause(kase.else_clause, depth) : []),
        ]
      }
      case "AST_ERB_BLOCK_NODE":
      case "AST_ERB_ITERATION_BLOCK_NODE":
      case "AST_ERB_RENDER_NODE": {
        const block = node as Nodes.ERBBlockNode
        const indicator = this.indicator(block)
        const code = erbCode(block).trim()
        const brace = /\{\s*(\|[^|]*\|)?\s*$/.test(code) && !/\bdo\s*(\|[^|]*\|)?\s*$/.test(code)

        return [
          ...this.codeLine(indicator, block, depth),
          ...this.block(block.body ?? [], depth + 1),
          ...(block.rescue_clause ? this.rescue(block.rescue_clause, depth) : []),
          ...(block.else_clause ? this.clause(block.else_clause, depth) : []),
          ...(block.ensure_clause ? this.clause(block.ensure_clause, depth) : []),
          ...(brace ? [indent + "- }"] : []),
        ]
      }
      case "AST_ERB_BEGIN_NODE": {
        const begin = node as Nodes.ERBBeginNode
        return [
          ...this.codeLine(this.indicator(begin), begin, depth),
          ...this.block(begin.statements, depth + 1),
          ...(begin.rescue_clause ? this.rescue(begin.rescue_clause, depth) : []),
          ...(begin.else_clause ? this.clause(begin.else_clause, depth) : []),
          ...(begin.ensure_clause ? this.clause(begin.ensure_clause, depth) : []),
        ]
      }
      case "AST_ERB_WHILE_NODE":
      case "AST_ERB_UNTIL_NODE":
      case "AST_ERB_FOR_NODE": {
        const loop = node as Nodes.ERBWhileNode
        return [...this.codeLine(this.indicator(loop), loop, depth), ...this.block(loop.statements, depth + 1)]
      }
      case "AST_ERB_CONTENT_NODE":
      case "AST_ERB_YIELD_NODE": {
        const erb = node as Nodes.ERBContentNode
        const opening = erbOpening(erb)

        if (opening === "<%=" || opening === "<%==") return this.codeLine(opening === "<%==" ? "==" : "=", erb, depth)

        const lines = codeLines(erbCode(erb))

        if (lines.some(line => /^=(begin|end)\b/.test(line))) {
          return this.unsupported(node, "Ruby `=begin`/`=end` block comments need to start a line, which Slim code lines can't.", depth)
        }

        if (lines.length <= 1) return this.codeLine("-", erb, depth)

        // multi-line Ruby: an embedded `ruby:` block
        return [indent + "ruby:", ...lines.map(line => (line.length > 0 ? this.indent(depth + 1) + line : ""))]
      }
      case "AST_ERB_COMMENT_NODE": {
        const lines = codeLines(erbCode(node as Nodes.ERBCommentNode))
        if (lines.length === 0) return [indent + "/"]

        return [indent + "/ " + lines[0], ...lines.slice(1).map(line => (line.length > 0 ? this.indent(depth + 1) + line : ""))]
      }
      case "AST_HTML_COMMENT_NODE": return this.comment(node as Nodes.HTMLCommentNode, depth)
      case "AST_HTML_DOCTYPE_NODE": {
        const doctype = node as Nodes.HTMLDoctypeNode
        if (!doctype.children.every(child => child.type === "AST_LITERAL_NODE")) return this.unsupported(node, "ERB inside a doctype has no Slim form.", depth)

        const value = doctype.children.map(child => (child as Nodes.LiteralNode).content ?? "").join("").trim()
        const known = Object.entries(DOCTYPES).find(([html]) => html.toLowerCase() === value.toLowerCase())

        return [indent + (known ? `doctype ${known[1]}` : `<!DOCTYPE ${value}>`)]
      }
      case "AST_XML_DECLARATION_NODE": {
        const declaration = node as Nodes.XMLDeclarationNode
        const value = declaration.children.map(child => (child as Nodes.LiteralNode).content ?? "").join("")
        const match = value.match(/^\s*version="1\.0" encoding="([^"]*)"\s*$/)

        if (match) return [indent + (match[1] === "utf-8" ? "doctype xml" : `doctype xml ${match[1]}`)]

        return [indent + `<?xml${value}?>`]
      }
      case "AST_CDATA_NODE": {
        const cdata = node as Nodes.CDATANode
        return [indent + (cdata.tag_opening?.value ?? "") + cdata.children.map(child => (child as Nodes.LiteralNode).content ?? "").join("") + (cdata.tag_closing?.value ?? "")]
      }
      case "AST_ERB_END_NODE":
      case "AST_ERB_ELSE_NODE":
      case "AST_HTML_OPEN_TAG_NODE":
      case "AST_HTML_CLOSE_TAG_NODE":
      default:
        return this.unsupported(node, `${node.type.replace(/^AST_/, "").toLowerCase()} has no Slim form here.`, depth)
    }
  }

  // `=` / `==` for an ERB tag that outputs its value (`<%= if x %>`, `<%= form_with do %>`), `-` otherwise.
  private indicator(node: Node): string {
    const opening = erbOpening(node as Nodes.ERBContentNode)

    return opening === "<%==" ? "==" : opening === "<%=" ? "=" : "-"
  }

  private clause(node: Nodes.ERBElseNode | Nodes.ERBWhenNode | Nodes.ERBEnsureNode, depth: number): string[] {
    return [...this.codeLine("-", node, depth), ...this.block(node.statements, depth + 1)]
  }

  private rescue(node: Nodes.ERBRescueNode, depth: number): string[] {
    return [
      ...this.codeLine("-", node, depth),
      ...this.block(node.statements, depth + 1),
      ...(node.subsequent ? this.rescue(node.subsequent, depth) : []),
    ]
  }

  // `- code` / `= code` / `== code`; multi-line code continues on the next lines (Slim's broken lines, which need
  // a trailing `,` or `\`).
  private codeLine(indicator: string, node: Node, depth: number): string[] {
    const indent = this.indent(depth)
    const lines = codeLines(erbCode(node as Nodes.ERBContentNode))

    if (lines.length === 0) return [indent + indicator]

    const continued = lines.map((line, index) => (index < lines.length - 1 && !/[,\\]$/.test(line) ? line + " \\" : line))

    return [indent + indicator + " " + continued[0], ...continued.slice(1).map(line => this.indent(depth + 1) + line)]
  }

  private comment(node: Nodes.HTMLCommentNode, depth: number): string[] {
    const indent = this.indent(depth)
    const content = node.children.map(child => (child.type === "AST_LITERAL_NODE" ? (child as Nodes.LiteralNode).content : new ReadableSource(child).text())).join("")
    const conditional = content.match(/^\[if ([^\]]*)\]>([\s\S]*)<!\[endif\]$/)

    if (conditional) {
      let inner: string[] = []

      if (conditional[2].trim() !== "") {
        if (!this.parse) {
          this.errors.push(diagnosticAt(node, "unsupported-erb", "The content of a conditional comment can only be converted with a parser (`parse` option)."))
          return [indent + `/[if ${conditional[1]}]`]
        }

        const result = this.parse(conditional[2])
        inner = this.block(result.value?.children ?? [], depth + 1)
      }

      return [indent + `/[if ${conditional[1]}]`, ...inner]
    }

    const lines = content.split("\n")

    // whitespace around a one-line comment's text isn't kept (`<!-- note -->` => `/! note`)
    if (lines.length === 1) return [indent + ("/! " + content.trim()).trimEnd()]

    const rest = dedent(lines.slice(1))

    return [indent + "/! " + lines[0], ...rest.map(line => (line.trim() === "" ? "" : indent + "   " + line))]
  }
}

// The HTML+ERB of a node, for diagnostics and `/ herb:` placeholders.
class ReadableSource {
  constructor(private readonly node: Node) {}

  text(): string {
    return this.visit(this.node)
  }

  private visit(node: Node | null | undefined): string {
    if (!node) return ""

    if (isERBTag(node)) {
      const erb = node as Nodes.ERBContentNode
      const own = `${erbOpening(erb)} ${erbCode(erb).trim()} %>`
      const children = ["statements", "body", "children", "conditions"].flatMap(key => ((node as unknown as Record<string, Node[] | undefined>)[key] ?? []))
      const subsequent = ["subsequent", "else_clause", "rescue_clause", "ensure_clause", "end_node"].map(key => (node as unknown as Record<string, Node | null>)[key])

      return own + children.map(child => this.visit(child)).join("") + subsequent.map(child => this.visit(child)).join("")
    }

    switch (node.type) {
      case "AST_HTML_TEXT_NODE":
      case "AST_LITERAL_NODE":
        return (node as Nodes.HTMLTextNode).content
      default: {
        const record = node as unknown as Record<string, unknown>
        const children = (["open_tag", "children", "body", "value", "name", "close_tag"] as const).flatMap(key => {
          const value = record[key]
          return Array.isArray(value) ? value : value ? [value] : []
        })

        return children.map(child => this.visit(child as Node)).join("")
      }
    }
  }
}
