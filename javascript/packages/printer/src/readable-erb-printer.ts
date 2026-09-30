import { isInlineElement, isParseResult, isVoidElement } from "@herb-tools/core"

import { codeLines, dedent, erbCode, erbOpening, flowsInline, isERBOutput, isERBTag, isRepeatedBlock } from "./erb-tags.js"
import { diagnosticAt } from "./conversion-diagnostic.js"

import type * as Nodes from "@herb-tools/core"
import type { Node, ParseResult } from "@herb-tools/core"
import type { ConversionDiagnostic } from "./conversion-diagnostic.js"

export interface ReadableERBPrinterOptions {
  /** Spaces per nesting level. Defaults to 2. */
  indentWidth?: number
  /**
   * Names of attributes whose values are merged (Slim's `merge_attrs`). Their Ruby values are reported as
   * `dynamic-class` instead of `dynamic-attribute`. Defaults to `{ class: " " }`.
   */
  mergeAttrs?: Record<string, string>
}

const WHITESPACE_PRESERVING = new Set(["pre", "textarea"])
const RAW_TEXT = new Set(["script", "style"])

// Marks a line that is only whitespace, to be appended to the previous line (see `attachWhitespace`).
const ATTACH = "\u0000"

/**
 * Prints a Herb syntax tree as idiomatic, indented HTML+ERB: one element per line with its content indented,
 * text and ERB output that belong together on one line, and `<% if x %>` ... `<% end %>` blocks.
 *
 * It is made for the source-faithful trees of indentation-based frontends (`Herb.parse(source, { language:
 * "slim" })`), which contain no formatting whitespace: the layout it adds is formatting only, except between
 * inline siblings (text, ERB output, inline elements) that end up on different lines, which it reports as
 * `whitespace` warnings. Every other place where the printed ERB renders differently from the source
 * language (Slim's attribute semantics) is reported in `warnings` too.
 */
export class ReadableERBPrinter {
  readonly warnings: ConversionDiagnostic[] = []

  private readonly indentWidth: number
  private readonly mergeAttrs: Record<string, string>
  private rawTextDepth = 0

  static print(input: Node | ParseResult, options: ReadableERBPrinterOptions = {}): string {
    return new ReadableERBPrinter(options).print(input)
  }

  constructor(options: ReadableERBPrinterOptions = {}) {
    this.indentWidth = options.indentWidth ?? 2
    this.mergeAttrs = options.mergeAttrs ?? { class: " " }
  }

  print(input: Node | ParseResult): string {
    const node = isParseResult(input) ? input.value : input
    const children = node.type === "AST_DOCUMENT_NODE" ? (node as Nodes.DocumentNode).children : [node]
    const lines = this.attachWhitespace(this.block(children, 0))

    this.warnings.sort((a, b) => a.line - b.line || a.column - b.column)

    return lines.length > 0 ? lines.join("\n") + "\n" : ""
  }

  // --- layout ---------------------------------------------------------------------------------------------------

  private indent(depth: number): string {
    return " ".repeat(depth * this.indentWidth)
  }

  // Whitespace-only lines (significant whitespace between two block items) and the leading whitespace of a line
  // go at the end of the previous line, so that a line break never swallows them.
  private attachWhitespace(lines: string[]): string[] {
    const result: string[] = []

    for (const line of lines) {
      if (line.startsWith(ATTACH)) {
        const whitespace = line.slice(1)

        if (result.length > 0) {
          result[result.length - 1] += whitespace
        } else {
          result.push(whitespace)
        }
      } else {
        result.push(line)
      }
    }

    return result
  }

  /** Whether the node flows inline with text: text, ERB output, and (for the whitespace warning) inline elements. */
  private isInlineItem(node: Node): boolean {
    if (node.type === "AST_HTML_TEXT_NODE" || node.type === "AST_LITERAL_NODE") return true
    if (isERBOutput(node)) return !erbCode(node).includes("\n")

    return false
  }

  private isInlineLevel(node: Node): boolean {
    if (this.isInlineItem(node)) return true
    if (node.type !== "AST_HTML_ELEMENT_NODE") return false

    const name = (node as Nodes.HTMLElementNode).tag_name?.value ?? ""

    return isInlineElement(name)
  }

  private block(nodes: Node[], depth: number, repeated = false): string[] {
    const entries: ({ kind: "run", nodes: Node[] } | { kind: "node", node: Node })[] = []
    let previous: Node | null = null

    for (const node of nodes) {
      if (node.type === "AST_WHITESPACE_NODE") continue

      const last = entries[entries.length - 1]

      if (this.isInlineItem(node)) {
        if (last?.kind !== "run" && previous && this.isInlineLevel(previous) && !this.startsWithWhitespace(node)) {
          this.warnWhitespace(node)
        }

        if (last?.kind === "run") {
          last.nodes.push(node)
        } else {
          entries.push({ kind: "run", nodes: [node] })
        }

        previous = node
        continue
      }

      if (previous && this.isInlineLevel(previous) && this.isInlineLevel(node) && !this.endsWithWhitespace(previous)) {
        this.warnWhitespace(node)
      }

      entries.push({ kind: "node", node })
      previous = node
    }

    const lines: string[] = []

    entries.forEach((entry, index) => {
      if (entry.kind === "node") {
        lines.push(...this.blockNode(entry.node, depth))
        return
      }

      // The line break next to an inline element renders as a space already (`<code>x</code>` + newline + `and`),
      // and so do the line breaks at the ends of a loop body whose ends are inline (between the iterations).
      const neighbour = (other: (typeof entries)[number] | undefined) => other?.kind === "node" && flowsInline(other.node)
      const loopEdge = repeated && this.flowingEdges(entries)

      lines.push(...this.runLines(
        entry.nodes,
        depth,
        neighbour(entries[index - 1]) || (loopEdge && index === 0),
        neighbour(entries[index + 1]) || (loopEdge && index === entries.length - 1),
      ))
    })

    return lines
  }

  // Whether the first and the last content of a body flow inline (text, output, inline elements).
  private flowingEdges(entries: ({ kind: "run", nodes: Node[] } | { kind: "node", node: Node })[]): boolean {
    const flows = (entry: (typeof entries)[number] | undefined) => {
      if (!entry) return false
      if (entry.kind === "node") return flowsInline(entry.node)

      return entry.nodes.some(node => isERBOutput(node) || this.inline(node).trim() !== "")
    }

    return flows(entries[0]) && flows(entries[entries.length - 1])
  }

  private startsWithWhitespace(node: Node): boolean {
    return (node.type === "AST_HTML_TEXT_NODE" || node.type === "AST_LITERAL_NODE") && /^\s/.test((node as Nodes.HTMLTextNode).content)
  }

  private endsWithWhitespace(node: Node): boolean {
    return (node.type === "AST_HTML_TEXT_NODE" || node.type === "AST_LITERAL_NODE") && /\s$/.test((node as Nodes.HTMLTextNode).content)
  }

  private warnWhitespace(node: Node): void {
    this.warnings.push(
      diagnosticAt(
        node,
        "whitespace",
        "Adjacent inline content is printed on separate lines, so the ERB renders a space here that the source doesn't.",
      ),
    )
  }

  // Text and ERB output that belong together, on one line (or several, for text with line breaks). The
  // whitespace at an end that is next to an inline element is left to the line break (`afterInline` /
  // `beforeInline`), which renders the same.
  private runLines(run: Node[], depth: number, afterInline = false, beforeInline = false): string[] {
    let text = run.map(node => this.inline(node)).join("")

    if (this.rawTextDepth === 0) {
      if (text.trim() === "") {
        if (afterInline && beforeInline) return []
      } else {
        if (afterInline) text = text.replace(/^[ \t]+/, "")
        if (beforeInline) text = text.replace(/[ \t]+$/, "")
      }
    }

    const leading = text.match(/^[ \t]*/)![0]
    const rest = text.slice(leading.length)
    const lines: string[] = []

    if (leading.length > 0) lines.push(ATTACH + leading)
    if (rest.length === 0) return lines

    for (const line of rest.split("\n")) {
      lines.push(line.length > 0 ? this.indent(depth) + line : "")
    }

    return lines
  }

  private blockNode(node: Node, depth: number): string[] {
    const indent = this.indent(depth)

    switch (node.type) {
      case "AST_HTML_ELEMENT_NODE": return this.element(node as Nodes.HTMLElementNode, depth)
      case "AST_ERB_IF_NODE": return this.ifLines(node as Nodes.ERBIfNode, depth)
      case "AST_ERB_UNLESS_NODE": {
        const unless = node as Nodes.ERBUnlessNode
        return [
          ...this.tagLines(unless, depth),
          ...this.block(unless.statements, depth + 1),
          ...(unless.else_clause ? this.clauseLines(unless.else_clause, depth) : []),
          ...this.endLines(unless.end_node, depth),
        ]
      }
      case "AST_ERB_BLOCK_NODE":
      case "AST_ERB_ITERATION_BLOCK_NODE":
      case "AST_ERB_RENDER_NODE": {
        const block = node as Nodes.ERBBlockNode
        this.warnRepeatedWhitespace(block, block.body ?? [])
        return [
          ...this.tagLines(block, depth),
          ...this.block(block.body ?? [], depth + 1, isRepeatedBlock(block)),
          ...(block.rescue_clause ? this.rescueLines(block.rescue_clause, depth) : []),
          ...(block.else_clause ? this.clauseLines(block.else_clause, depth) : []),
          ...(block.ensure_clause ? this.clauseLines(block.ensure_clause, depth) : []),
          ...this.endLines(block.end_node, depth),
        ]
      }
      case "AST_ERB_BEGIN_NODE": {
        const begin = node as Nodes.ERBBeginNode
        return [
          ...this.tagLines(begin, depth),
          ...this.block(begin.statements, depth + 1),
          ...(begin.rescue_clause ? this.rescueLines(begin.rescue_clause, depth) : []),
          ...(begin.else_clause ? this.clauseLines(begin.else_clause, depth) : []),
          ...(begin.ensure_clause ? this.clauseLines(begin.ensure_clause, depth) : []),
          ...this.endLines(begin.end_node, depth),
        ]
      }
      case "AST_ERB_CASE_NODE":
      case "AST_ERB_CASE_MATCH_NODE": {
        const kase = node as Nodes.ERBCaseNode
        return [
          ...this.tagLines(kase, depth),
          ...this.block(kase.children.filter(child => !this.isBlankText(child)), depth + 1),
          ...kase.conditions.flatMap(condition => this.clauseLines(condition as Nodes.ERBWhenNode, depth)),
          ...(kase.else_clause ? this.clauseLines(kase.else_clause, depth) : []),
          ...this.endLines(kase.end_node, depth),
        ]
      }
      case "AST_ERB_WHILE_NODE":
      case "AST_ERB_UNTIL_NODE":
      case "AST_ERB_FOR_NODE": {
        const loop = node as Nodes.ERBWhileNode
        this.warnRepeatedWhitespace(loop, loop.statements)
        return [...this.tagLines(loop, depth), ...this.block(loop.statements, depth + 1, true), ...this.endLines(loop.end_node, depth)]
      }
      case "AST_ERB_CONTENT_NODE":
      case "AST_ERB_YIELD_NODE":
      case "AST_ERB_COMMENT_NODE":
      case "AST_ERB_END_NODE":
      case "AST_ERB_ELSE_NODE":
        return this.tagLines(node as Nodes.ERBContentNode, depth)
      case "AST_HTML_COMMENT_NODE": return this.comment(node as Nodes.HTMLCommentNode, depth)
      case "AST_HTML_DOCTYPE_NODE":
      case "AST_XML_DECLARATION_NODE":
      case "AST_CDATA_NODE": {
        const doctype = node as Nodes.HTMLDoctypeNode
        return [indent + (doctype.tag_opening?.value ?? "") + this.inlineAll(doctype.children) + (doctype.tag_closing?.value ?? "")]
      }
      case "AST_HTML_OPEN_TAG_NODE": return [indent + this.openTag(node as Nodes.HTMLOpenTagNode)]
      case "AST_HTML_CLOSE_TAG_NODE": {
        const close = node as Nodes.HTMLCloseTagNode
        return [indent + `</${close.tag_name?.value ?? ""}>`]
      }
      default: return [indent + this.inline(node)]
    }
  }

  // A block that can run more than once (a loop, `each do`) with inline content at its start or end: the line
  // breaks around the body render between the iterations (`Hey!Hey!` becomes `Hey! Hey!`).
  private warnRepeatedWhitespace(node: Node, body: Node[]): void {
    const content = body.filter(child => child.type !== "AST_WHITESPACE_NODE")
    const first = content[0]
    const last = content[content.length - 1]

    if (!first || !(this.isInlineLevel(first) || this.isInlineLevel(last))) return
    // the source renders whitespace between the iterations too
    if (this.startsWithWhitespace(first) || this.endsWithWhitespace(last)) return

    this.warnings.push(
      diagnosticAt(
        node,
        "whitespace",
        "The block's inline content is printed on its own lines, so the ERB renders whitespace between its iterations that the source doesn't.",
      ),
    )
  }

  private isBlankText(node: Node): boolean {
    return (node.type === "AST_HTML_TEXT_NODE" || node.type === "AST_LITERAL_NODE") && (node as Nodes.HTMLTextNode).content.trim() === ""
  }

  private ifLines(node: Nodes.ERBIfNode, depth: number): string[] {
    const lines = [...this.tagLines(node, depth), ...this.block(node.statements, depth + 1)]
    let subsequent: Nodes.ERBIfNode | Nodes.ERBElseNode | null = node.subsequent

    while (subsequent) {
      lines.push(...this.tagLines(subsequent, depth), ...this.block(subsequent.statements, depth + 1))
      subsequent = subsequent.type === "AST_ERB_IF_NODE" ? (subsequent as Nodes.ERBIfNode).subsequent : null
    }

    return [...lines, ...this.endLines(node.end_node, depth)]
  }

  private clauseLines(node: Nodes.ERBElseNode | Nodes.ERBWhenNode | Nodes.ERBEnsureNode, depth: number): string[] {
    return [...this.tagLines(node, depth), ...this.block(node.statements, depth + 1)]
  }

  private rescueLines(node: Nodes.ERBRescueNode, depth: number): string[] {
    return [
      ...this.clauseLines(node as unknown as Nodes.ERBElseNode, depth),
      ...(node.subsequent ? this.rescueLines(node.subsequent, depth) : []),
    ]
  }

  private endLines(node: Nodes.ERBEndNode | null, depth: number): string[] {
    return node ? this.tagLines(node, depth) : [this.indent(depth) + "<% end %>"]
  }

  // An ERB tag on its own line(s). Multi-line code goes between `<%` and `%>` lines, indented one level
  // (at the tag's own indentation when it contains a heredoc, whose content indentation matters).
  private tagLines(node: Node, depth: number): string[] {
    const indent = this.indent(depth)
    const erb = node as Nodes.ERBContentNode
    const opening = erbOpening(erb)
    const lines = codeLines(erbCode(erb))

    if (lines.length <= 1) return [indent + this.tag(node)]

    const heredoc = /<<[~-]?(["'`]?)[A-Za-z_]\w*\1/.test(erbCode(erb))
    const inner = heredoc ? indent : this.indent(depth + 1)

    return [indent + opening, ...lines.map(line => (line.length > 0 ? inner + line : "")), indent + "%>"]
  }

  // --- elements -------------------------------------------------------------------------------------------------

  private element(node: Nodes.HTMLElementNode, depth: number): string[] {
    const indent = this.indent(depth)
    const name = node.tag_name?.value ?? "div"

    if (!node.open_tag || node.open_tag.type !== "AST_HTML_OPEN_TAG_NODE") {
      return [indent + this.inline(node)]
    }

    const open = this.openTag(node.open_tag as Nodes.HTMLOpenTagNode)
    const close = `</${name}>`

    if (node.is_void || isVoidElement(name) || !node.close_tag) {
      return [indent + open]
    }

    const body = node.body.filter(child => child.type !== "AST_WHITESPACE_NODE")

    if (body.length === 0) return [indent + open + close]

    if (WHITESPACE_PRESERVING.has(name.toLowerCase())) {
      const [first, ...rest] = this.inlineAll(body).split("\n")
      const lines = [indent + open + first, ...rest]
      lines[lines.length - 1] += close

      return lines
    }

    if (RAW_TEXT.has(name.toLowerCase())) this.rawTextDepth++

    try {
      if (body.every(child => this.isInlineItem(child))) {
        const inline = this.inlineAll(body)

        if (!inline.includes("\n")) return [indent + open + inline + close]

        if (RAW_TEXT.has(name.toLowerCase())) {
          const lines = dedent(inline.split("\n"))

          while (lines.length > 0 && lines[0].trim() === "") lines.shift()
          while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()

          return [indent + open, ...lines.map(line => (line.trim() === "" ? "" : this.indent(depth + 1) + line)), indent + close]
        }
      }

      return [indent + open, ...this.block(body, depth + 1), indent + close]
    } finally {
      if (RAW_TEXT.has(name.toLowerCase())) this.rawTextDepth--
    }
  }

  private openTag(node: Nodes.HTMLOpenTagNode): string {
    let output = `<${node.tag_name?.value ?? ""}`

    for (const child of node.children) {
      switch (child.type) {
        case "AST_WHITESPACE_NODE":
          if (!/\s$/.test(output)) output += " "
          break
        case "AST_HTML_ATTRIBUTE_NODE":
          if (!/\s$/.test(output)) output += " "
          output += this.attribute(child as Nodes.HTMLAttributeNode)
          break
        case "AST_RUBY_HTML_ATTRIBUTES_SPLAT_NODE": {
          const splat = child as Nodes.RubyHTMLAttributesSplatNode

          if (!/\s$/.test(output)) output += " "
          output += `<%= ${splat.content} %>`

          if (!splat.prefix) {
            this.warnings.push(
              diagnosticAt(
                child,
                "attribute-splat",
                "Attribute splats are printed as Rails' `tag.attributes` (Rails 7.1+), which neither merges `class` with the element's other classes nor sorts the attributes like Slim.",
              ),
            )
          }
          break
        }
        default:
          output += this.inline(child)
      }
    }

    output = output.replace(/\s+$/, "")

    const closing = node.tag_closing?.value ?? ">"
    const name = node.tag_name?.value ?? ""

    // void elements are always written `<br>`; other self-closing tags (Slim's `div/`) as `<div />`
    return output + (closing === "/>" && !isVoidElement(name) ? " />" : ">")
  }

  private attribute(node: Nodes.HTMLAttributeNode): string {
    const name = this.inlineAll(node.name?.children ?? [])

    if (!node.value) return name

    const value = node.value
    const quote = value.open_quote?.value === "'" ? "'" : '"'
    const children = value.children

    this.checkAttributeSemantics(name, value)

    return `${name}=${quote}${children.map(child => this.inline(child, true)).join("")}${quote}`
  }

  // A Ruby attribute value from an indentation-based template (`href=@url`) has no quotes in the source.
  private checkAttributeSemantics(name: string, value: Nodes.HTMLAttributeValueNode): void {
    const quote = value.open_quote
    const synthetic = !quote || (quote.location.start.line === quote.location.end.line && quote.location.start.column === quote.location.end.column)

    if (!synthetic) return

    const outputs = value.children.filter(child => isERBOutput(child))
    if (outputs.length === 0) return

    if (name in this.mergeAttrs) {
      this.warnings.push(
        diagnosticAt(
          outputs[0],
          "dynamic-class",
          `\`${name}\` has a Ruby value: Slim flattens Arrays and joins them with "${this.mergeAttrs[name]}", and omits the attribute when the value is empty; the ERB renders the value's \`to_s\`.`,
        ),
      )
      return
    }

    if (value.children.length !== 1) return

    const code = erbCode(outputs[0]).trim()

    if (/^(["'].*["']|%[qQ]?\{.*\}|-?\d[\d_.]*|:\w+)$/s.test(code)) return

    this.warnings.push(
      diagnosticAt(
        outputs[0],
        "dynamic-attribute",
        `\`${name}=${code}\`: Slim omits the attribute when the value is nil or false and renders a bare \`${name}\` when it is true; the ERB always renders \`${name}="…"\`${code.includes("\n") ? "" : ` (converted back to Slim, it is \`${name}="#{${code}}"\`)`}.`,
      ),
    )
  }

  private comment(node: Nodes.HTMLCommentNode, depth: number): string[] {
    const indent = this.indent(depth)
    const children = node.children
    const first = children[0]
    const last = children[children.length - 1]

    // Slim's `/[if IE]` conditional comment: `<!--[if IE]>` children `<![endif]-->`
    if (
      children.length >= 2 &&
      first.type === "AST_LITERAL_NODE" && /^\[if [^\]]*\]>$/.test((first as Nodes.LiteralNode).content) &&
      last.type === "AST_LITERAL_NODE" && (last as Nodes.LiteralNode).content === "<![endif]"
    ) {
      return [
        indent + "<!--" + (first as Nodes.LiteralNode).content,
        ...this.block(children.slice(1, -1), depth + 1),
        indent + "<![endif]-->",
      ]
    }

    const content = this.inlineAll(children)
    const [head, ...rest] = content.split("\n")

    if (rest.length === 0) return [indent + "<!--" + head + "-->"]

    const lines = [indent + "<!--" + head, ...rest.map(line => (line.length > 0 ? this.indent(depth) + line : ""))]
    lines[lines.length - 1] += "-->"

    return lines
  }

  // --- inline ---------------------------------------------------------------------------------------------------

  private inlineAll(nodes: Node[]): string {
    return nodes.map(node => this.inline(node)).join("")
  }

  private tag(node: Node): string {
    const opening = erbOpening(node as Nodes.ERBContentNode)
    const code = erbCode(node as Nodes.ERBContentNode)

    if (code.includes("\n")) return `${opening}${code}%>`
    if (code.trim() === "") return `${opening} %>`

    return `${opening} ${code.trim()} %>`
  }

  // A literal `<%` or `%>` in text would become an ERB tag: in HTML it is written as an entity, in <script> and
  // <style> (where entities aren't decoded) as ERB output.
  private text(content: string, attribute = false): string {
    if (this.rawTextDepth > 0 && !attribute) {
      return content.replace(/<%|%>/g, match => (match === "<%" ? '<%== "<" + "%" %>' : '<%== "%" + ">" %>'))
    }

    return content.replace(/<%/g, "&lt;%").replace(/%>/g, "%&gt;")
  }

  private inline(node: Node, attribute = false): string {
    switch (node.type) {
      case "AST_HTML_TEXT_NODE":
      case "AST_LITERAL_NODE":
        return this.text((node as Nodes.HTMLTextNode).content, attribute)
      case "AST_WHITESPACE_NODE":
        return (node as Nodes.WhitespaceNode).value?.value ?? " "
      case "AST_HTML_ELEMENT_NODE": {
        const element = node as Nodes.HTMLElementNode

        if (element.open_tag?.type !== "AST_HTML_OPEN_TAG_NODE") {
          return this.inline(element.open_tag as Node) + this.inlineAll(element.body) + (element.close_tag ? this.inline(element.close_tag) : "")
        }

        const open = this.openTag(element.open_tag as Nodes.HTMLOpenTagNode)
        const name = element.tag_name?.value ?? ""

        if (element.is_void || !element.close_tag) return open

        return open + this.inlineAll(element.body) + `</${name}>`
      }
      case "AST_HTML_ATTRIBUTE_NODE": return this.attribute(node as Nodes.HTMLAttributeNode)
      case "AST_RUBY_HTML_ATTRIBUTES_SPLAT_NODE": return `<%= ${(node as Nodes.RubyHTMLAttributesSplatNode).content} %>`
      case "AST_HTML_OPEN_TAG_NODE": return this.openTag(node as Nodes.HTMLOpenTagNode)
      case "AST_HTML_CLOSE_TAG_NODE": return `</${(node as Nodes.HTMLCloseTagNode).tag_name?.value ?? ""}>`
      case "AST_HTML_COMMENT_NODE": {
        const comment = node as Nodes.HTMLCommentNode
        return "<!--" + this.inlineAll(comment.children) + "-->"
      }
      case "AST_ERB_IF_NODE": {
        const ifNode = node as Nodes.ERBIfNode
        let output = this.tag(ifNode) + this.inlineAll(ifNode.statements)
        let subsequent: Nodes.ERBIfNode | Nodes.ERBElseNode | null = ifNode.subsequent

        while (subsequent) {
          output += this.tag(subsequent) + this.inlineAll(subsequent.statements)
          subsequent = subsequent.type === "AST_ERB_IF_NODE" ? (subsequent as Nodes.ERBIfNode).subsequent : null
        }

        return output + (ifNode.end_node ? this.tag(ifNode.end_node) : "<% end %>")
      }
      case "AST_ERB_UNLESS_NODE": {
        const unless = node as Nodes.ERBUnlessNode
        return this.tag(unless) + this.inlineAll(unless.statements) + (unless.else_clause ? this.tag(unless.else_clause) + this.inlineAll(unless.else_clause.statements) : "") + (unless.end_node ? this.tag(unless.end_node) : "<% end %>")
      }
      case "AST_ERB_BLOCK_NODE": {
        const block = node as Nodes.ERBBlockNode
        return this.tag(block) + this.inlineAll(block.body) + (block.end_node ? this.tag(block.end_node) : "<% end %>")
      }
      case "AST_ERB_CASE_NODE": {
        const kase = node as Nodes.ERBCaseNode
        return this.tag(kase) + kase.conditions.map(condition => this.tag(condition) + this.inlineAll((condition as Nodes.ERBWhenNode).statements)).join("") + (kase.else_clause ? this.tag(kase.else_clause) + this.inlineAll(kase.else_clause.statements) : "") + (kase.end_node ? this.tag(kase.end_node) : "<% end %>")
      }
      default:
        if (isERBTag(node)) return this.tag(node)

        return ""
    }
  }
}
