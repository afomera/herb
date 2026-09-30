import { isInlineElement } from "@herb-tools/core"

import type { Node, Token } from "@herb-tools/core"

type ERBTagLike = Node & { tag_opening?: Token | null, content?: Token | null, tag_closing?: Token | null }

/** `<%=`, `<%==`, `<%` or `<%#`, without the trim markers (`<%-`, `<%=-`, ...). */
export function erbOpening(node: ERBTagLike): string {
  const opening = node.tag_opening?.value ?? "<%"

  if (opening === "<%-") return "<%"
  if (opening.startsWith("<%==")) return "<%=="
  if (opening.startsWith("<%=")) return "<%="
  if (opening.startsWith("<%#")) return "<%#"
  if (opening.startsWith("<%%")) return "<%%"

  return "<%"
}

export function erbCode(node: ERBTagLike): string {
  return node.content?.value ?? ""
}

export function isERBTag(node: Node | null | undefined): node is ERBTagLike {
  return !!node && node.type.startsWith("AST_ERB_") && "tag_opening" in node
}

/** An ERB tag that outputs its value: `<%= %>` or `<%== %>` (without a block). */
export function isERBOutput(node: Node | null | undefined): node is ERBTagLike {
  if (!node) return false
  if (node.type !== "AST_ERB_CONTENT_NODE" && node.type !== "AST_ERB_YIELD_NODE") return false

  const opening = erbOpening(node as ERBTagLike)

  return opening === "<%=" || opening === "<%=="
}

/**
 * Splits (possibly multi-line) Ruby code into trimmed lines: the first line without its leading whitespace,
 * the following lines dedented by their common indentation. Blank leading and trailing lines are dropped.
 */
export function codeLines(code: string): string[] {
  const lines = code.replace(/\r\n/g, "\n").split("\n")

  while (lines.length > 0 && lines[0].trim() === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop()

  if (lines.length === 0) return []

  const [first, ...rest] = lines
  const indent = Math.min(...rest.filter(line => line.trim() !== "").map(line => line.match(/^[ \t]*/)![0].length))
  const firstWasBlank = code.replace(/\r\n/g, "\n").split("\n")[0].trim() === ""

  if (firstWasBlank) {
    const all = [first, ...rest]
    const common = Math.min(...all.filter(line => line.trim() !== "").map(line => line.match(/^[ \t]*/)![0].length))

    return all.map(line => line.slice(Math.min(common, line.match(/^[ \t]*/)![0].length)).trimEnd())
  }

  return [
    first.trim(),
    ...rest.map(line => (Number.isFinite(indent) ? line.slice(Math.min(indent, line.match(/^[ \t]*/)![0].length)) : line).trimEnd()),
  ]
}

/** Dedents text lines by their common indentation (blank lines ignored). */
export function dedent(lines: string[]): string[] {
  const indents = lines.filter(line => line.trim() !== "").map(line => line.match(/^[ \t]*/)![0].length)
  const common = indents.length > 0 ? Math.min(...indents) : 0

  return lines.map(line => line.slice(Math.min(common, line.match(/^[ \t]*/)![0].length)))
}

// Phrasing elements that flow with the text around them (`br`, `hr` and `wbr` break the line, so the whitespace
// around them doesn't render).
const LINE_BREAKING = new Set(["br", "hr", "wbr"])

/**
 * Whether whitespace next to this node renders: text, single-line ERB output and inline elements (`<code>`,
 * `<a>`, ...) flow inline, so a line break between two of them renders as a space.
 */
export function flowsInline(node: Node | null | undefined): boolean {
  if (!node) return false
  if (node.type === "AST_HTML_TEXT_NODE" || node.type === "AST_LITERAL_NODE") return true
  if (isERBOutput(node)) return !erbCode(node).includes("\n")
  if (node.type !== "AST_HTML_ELEMENT_NODE") return false

  const name = ((node as Node & { tag_name?: Token | null }).tag_name?.value ?? "").toLowerCase()

  return isInlineElement(name) && !LINE_BREAKING.has(name)
}

const ITERATION = /\.(each\w*|times|upto|downto|step|find_each|find_in_batches|cycle)\b|^\s*loop\b/

/**
 * Whether the body of an ERB block can render more than once (`each do`, `times do`, `while`, ...): the whitespace
 * at the ends of its body then renders between the iterations.
 */
export function isRepeatedBlock(node: Node | null | undefined): boolean {
  if (!node) return false

  switch (node.type) {
    case "AST_ERB_ITERATION_BLOCK_NODE":
    case "AST_ERB_WHILE_NODE":
    case "AST_ERB_UNTIL_NODE":
    case "AST_ERB_FOR_NODE":
      return true
    case "AST_ERB_BLOCK_NODE":
      return ITERATION.test(erbCode(node as ERBTagLike))
    default:
      return false
  }
}
