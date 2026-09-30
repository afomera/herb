import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { Herb } from "@herb-tools/node-wasm"

import { ConvertCLI, convertedPath } from "../src/convert-cli.js"

describe("herb-convert", () => {
  let directory: string
  let stdout: string
  let stderr: string

  beforeAll(async () => {
    await Herb.load()
  })

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "herb-convert-"))
    stdout = ""
    stderr = ""

    vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
      stdout += String(chunk)
      return true
    })
    vi.spyOn(console, "log").mockImplementation((...args) => { stdout += args.join(" ") + "\n" })
    vi.spyOn(console, "error").mockImplementation((...args) => { stderr += args.join(" ") + "\n" })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  function file(name: string, content: string): string {
    const path = join(directory, name)
    writeFileSync(path, content)

    return path
  }

  function run(...args: string[]): Promise<number> {
    return new ConvertCLI().run(["node", "herb-convert", ...args])
  }

  test("converted file names", () => {
    expect(convertedPath("app/views/users/show.html.slim", "erb")).toBe("app/views/users/show.html.erb")
    expect(convertedPath("app/views/users/show.html.erb", "slim")).toBe("app/views/users/show.html.slim")
    expect(convertedPath("show.herb", "slim")).toBe("show.slim")
  })

  test("prints Slim as ERB, with the readable-mode warnings on stderr", async () => {
    const path = file("show.html.slim", "a href=@url Link\n")

    expect(await run(path)).toBe(0)
    expect(stdout).toBe(`<a href="<%= @url %>">Link</a>\n`)
    expect(stderr).toContain(`${path}:1:7: warning: dynamic-attribute:`)
  })

  test("infers the direction from the extension and --write writes the sibling file", async () => {
    const path = file("show.html.erb", `<div class="card"><%= title %></div>\n`)

    expect(await run("--write", path)).toBe(0)
    expect(readFileSync(join(directory, "show.html.slim"), "utf-8")).toBe(".card = title\n")
  })

  test("prints ERB attribute values as a #{} interpolation, or attr=code with --idiomatic-attributes", async () => {
    const path = file("show.html.erb", `<a href="<%= url %>">Link</a>\n`)

    expect(await run(path)).toBe(0)
    expect(stdout).toBe(`a href="#{url}" Link\n`)
    expect(stderr).toBe("")

    stdout = ""

    expect(await run("--idiomatic-attributes", path)).toBe(0)
    expect(stdout).toBe("a href=url Link\n")
    expect(stderr).toContain(`${path}:1:9: warning: dynamic-attribute: \`href=url\` changes what renders`)
  })

  test("--to overrides the direction, --output picks the file", async () => {
    const path = file("snippet.txt", "p Hello\n")
    const output = join(directory, "out.erb")

    expect(await run("--from", "slim", "--to", "erb", "-o", output, path)).toBe(0)
    expect(readFileSync(output, "utf-8")).toBe("<p>Hello</p>\n")
  })

  test("--check writes nothing and fails on warnings", async () => {
    const clean = file("clean.html.slim", "p Hello\n")
    const warned = file("warned.html.slim", "a href=@url Link\n")

    expect(await run("--check", clean)).toBe(0)
    expect(await run("--check", warned)).toBe(1)
    expect(stdout).toBe("")
    expect(existsSync(join(directory, "clean.html.erb"))).toBe(false)
  })

  test("--dry-run shows what --write would do", async () => {
    const path = file("show.html.slim", "p Hello\n")

    expect(await run("--write", "--dry-run", path)).toBe(0)
    expect(stdout).toContain(`${path} -> ${join(directory, "show.html.erb")}`)
    expect(existsSync(join(directory, "show.html.erb"))).toBe(false)
  })

  test("ERB without a Slim form is an error and isn't written without --force", async () => {
    const path = file("show.html.erb", `<div <%= attributes %>>x</div>\n`)

    expect(await run("--write", path)).toBe(1)
    expect(stderr).toContain("unsupported-erb")
    expect(existsSync(join(directory, "show.html.slim"))).toBe(false)

    expect(await run("--write", "--force", path)).toBe(1)
    expect(readFileSync(join(directory, "show.html.slim"), "utf-8")).toBe("div x\n")
  })

  test("doesn't overwrite existing files without --force", async () => {
    const path = file("show.html.slim", "p Hello\n")
    file("show.html.erb", "existing\n")

    expect(await run("--write", path)).toBe(1)
    expect(readFileSync(join(directory, "show.html.erb"), "utf-8")).toBe("existing\n")
  })

  test("uses the project's Slim shortcuts from .herb.yml", async () => {
    file(".herb.yml", "slim:\n  shortcuts:\n    \"~\":\n      attr: data-testid\n    \".\":\n      attr: class\n")
    const path = file("show.html.slim", ".card~main Hello\n")

    expect(await run(path)).toBe(0)
    expect(stdout).toBe(`<div class="card" data-testid="main">Hello</div>\n`)
  })

  test("parse errors fail the conversion", async () => {
    const path = file("broken.html.slim", "? what\n")

    expect(await run(path)).toBe(1)
    expect(stderr).toContain("parse-error")
  })
})
