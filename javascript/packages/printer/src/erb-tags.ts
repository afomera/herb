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
