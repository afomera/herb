import type { SerializedNode } from "./nodes.js"
import type { ParseOptions } from "./parser-options.js"

export type DiffOperationType =
  | "attribute_added"
  | "attribute_removed"
  | "attribute_value_changed"
  | "erb_content_changed"
  | "node_inserted"
  | "node_moved"
  | "node_removed"
  | "node_replaced"
  | "node_unwrapped"
  | "node_wrapped"
  | "tag_name_changed"
  | "text_changed"
  | "whitespace_changed"

export interface DiffOperation {
  type: DiffOperationType
  path: number[]
  oldNode: SerializedNode | null
  newNode: SerializedNode | null
  oldIndex: number
  newIndex: number
}

export interface DiffResult {
  identical: boolean
  operations: DiffOperation[]
}

/**
 * Options for `Herb.diff`. Besides `track_whitespace_changes`, both sources are parsed with any
 * parser options given here, so a Slim template diffs as Slim:
 *
 *     Herb.diff(before, after, { language: "slim", exact_semantics: true })
 */
export interface DiffOptions extends ParseOptions {
  track_whitespace_changes?: boolean
}
