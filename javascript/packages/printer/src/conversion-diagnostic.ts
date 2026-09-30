import type { Node } from "@herb-tools/core"

/**
 * A place where a converted template does not render exactly what the source template renders, or a
 * construct that could not be converted.
 */
export interface ConversionDiagnostic {
  /** A stable identifier, e.g. `dynamic-attribute`, `whitespace` or `unsupported-erb`. */
  kind: string
  message: string
  /** 1-based line and 0-based column in the source template. */
  line: number
  column: number
}

export function diagnosticAt(node: Node | null | undefined, kind: string, message: string): ConversionDiagnostic {
  const start = node?.location?.start

  return { kind, message, line: start?.line ?? 1, column: start?.column ?? 0 }
}

export function formatDiagnostic(path: string, diagnostic: ConversionDiagnostic): string {
  return `${path}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.kind}: ${diagnostic.message}`
}
