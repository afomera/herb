import { describe, test, expect, beforeAll } from "vitest"
import { Herb } from "@herb-tools/node-wasm"
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FileProcessor } from "../src/cli/file-processor.js"

describe("FileProcessor", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  test("doesn't inline file content into offenses", async () => {
    const processor = new FileProcessor()
    const result = await processor.processFiles(["test/fixtures/multiple-rule-offenses.html.erb"], "simple")

    expect(result.allOffenses.length).toBeGreaterThan(0)

    for (const offense of result.allOffenses) {
      expect(offense.content).toBeUndefined()
    }
  })

  test("lints a .slim file as Slim and never fixes it with ERB", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herb-slim-"))
    const source = `DIV\n  img src="a.png"\n`

    try {
      writeFileSync(join(directory, "show.html.slim"), source)

      const processor = new FileProcessor()
      const result = await processor.processFiles(["show.html.slim"], "simple", { projectPath: directory, fix: true, only: ["html-tag-name-lowercase", "html-img-require-alt"] })
      const offenses = result.allOffenses.map(({ offense, autocorrectable }) => [offense.code, offense.location.start.line, autocorrectable])

      expect(offenses).toEqual([
        ["html-img-require-alt", 2, false],
        ["html-tag-name-lowercase", 1, false],
      ])

      expect(result.filesFixed).toBe(0)
      expect(readFileSync(join(directory, "show.html.slim"), "utf-8")).toBe(source)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
