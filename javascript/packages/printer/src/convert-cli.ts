import dedent from "dedent"

import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

import { Herb } from "@herb-tools/node-wasm"
import { Config } from "@herb-tools/config"
import { languageForPath, parserOptionsForLanguage } from "@herb-tools/core"

import { convertTemplate } from "./convert.js"
import { formatDiagnostic } from "./conversion-diagnostic.js"
import { version } from "../package.json"

import type { TemplateLanguage } from "@herb-tools/core"

interface ConvertCLIOptions {
  files: string[]
  from?: TemplateLanguage
  to?: TemplateLanguage
  output?: string
  write: boolean
  stdout: boolean
  check: boolean
  dryRun: boolean
  force: boolean
  warnings: boolean
  indentWidth?: number
  configFile?: string
  help: boolean
}

const LANGUAGES: TemplateLanguage[] = ["erb", "slim"]

/**
 * The file a converted template is written to: `show.html.slim` <=> `show.html.erb`.
 */
export function convertedPath(path: string, to: TemplateLanguage): string {
  if (to === "erb") return /\.slim$/i.test(path) ? path.replace(/\.slim$/i, ".erb") : `${path}.erb`

  return /\.(html\.erb|erb|herb)$/i.test(path) ? path.replace(/\.(erb|herb)$/i, ".slim") : `${path}.slim`
}

export class ConvertCLI {
  private parseArgs(args: string[]): ConvertCLIOptions {
    const options: ConvertCLIOptions = { files: [], write: false, stdout: false, check: false, dryRun: false, force: false, warnings: true, help: false }

    const language = (value: string | undefined, flag: string): TemplateLanguage => {
      if (!value || !LANGUAGES.includes(value as TemplateLanguage)) {
        throw new Error(`${flag} expects one of: ${LANGUAGES.join(", ")}`)
      }

      return value as TemplateLanguage
    }

    for (let index = 2; index < args.length; index++) {
      const arg = args[index]

      switch (arg) {
        case "--from": options.from = language(args[++index], "--from"); break
        case "--to": options.to = language(args[++index], "--to"); break
        case "-o":
        case "--output": options.output = args[++index]; break
        case "-w":
        case "--write": options.write = true; break
        case "--stdout": options.stdout = true; break
        case "--check": options.check = true; break
        case "--dry-run": options.dryRun = true; break
        case "--force": options.force = true; break
        case "--no-warnings": options.warnings = false; break
        case "--indent-width": options.indentWidth = Number(args[++index]); break
        case "--config-file": options.configFile = args[++index]; break
        case "-h":
        case "--help": options.help = true; break
        default:
          if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown option: ${arg}`)
          options.files.push(arg)
      }
    }

    return options
  }

  private showHelp(): void {
    console.log(dedent`
      herb-convert - Convert templates between Slim and HTML+ERB

      Slim is printed as readable, indented HTML+ERB, and HTML+ERB as idiomatic Slim. Places where the
      converted template renders differently (e.g. Slim omits \`href=nil\`, ERB renders \`href=""\`) are
      reported as warnings with their location.

      Usage:
        herb-convert [options] <file...>
        cat show.html.slim | herb-convert --from slim -

      Options:
        --from <slim|erb>       Source language (default: from the file extension, .slim is Slim)
        --to <slim|erb>         Target language (default: the other one)
        -o, --output <file>     Write the converted template to <file> (one input file)
        -w, --write             Write each converted template next to its source (show.html.slim -> show.html.erb)
        --stdout                Print the converted templates (the default without --write/--output)
        --check                 Convert without writing; exit with 1 if any file has errors or warnings
        --dry-run               Show what --write would do, without writing
        --force                 Write output even when some ERB had no Slim form, and overwrite existing files
        --no-warnings           Don't report readable-mode warnings
        --indent-width <n>      Spaces per nesting level (default: 2)
        --config-file <path>    Path to .herb.yml (its slim.shortcuts / slim.merge_attrs are used)
        -h, --help              Show this help message

      Examples:
        herb-convert app/views/users/show.html.slim            # print the ERB
        herb-convert --write app/views/users/show.html.slim    # write show.html.erb
        herb-convert --to slim --write app/views/**/*.html.erb
        herb-convert --check app/views/users/show.html.slim
    `)
  }

  async run(argv: string[] = process.argv): Promise<number> {
    let options: ConvertCLIOptions

    try {
      options = this.parseArgs(argv)
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`)
      return 2
    }

    if (options.help || options.files.length === 0) {
      this.showHelp()
      return options.help ? 0 : 2
    }

    if (options.output && options.files.length > 1) {
      console.error("Error: --output needs exactly one input file")
      return 2
    }

    await Herb.load()

    const config = await Config.loadForCLI(options.configFile || options.files.find(file => file !== "-") || process.cwd(), version, false)
    let failed = false
    let warned = false

    for (const file of options.files) {
      const stdin = file === "-"
      const path = stdin ? "(stdin)" : file
      const from = options.from ?? (options.to ? (options.to === "slim" ? "erb" : "slim") : languageForPath(file))
      const to = options.to ?? (from === "slim" ? "erb" : "slim")

      if (from === to) {
        console.error(`${path}: nothing to convert (source and target are both ${from})`)
        failed = true
        continue
      }

      let source: string

      try {
        source = readFileSync(stdin ? 0 : resolve(file), "utf-8")
      } catch (error) {
        console.error(`${path}: ${(error as Error).message}`)
        failed = true
        continue
      }

      const result = convertTemplate(Herb, source, from, to, {
        indentWidth: options.indentWidth,
        slimParserOptions: parserOptionsForLanguage("slim", config),
        erbParserOptions: parserOptionsForLanguage("erb", config),
      })

      for (const error of result.errors) console.error(formatDiagnostic(path, error))

      if (options.warnings) {
        for (const warning of result.warnings) console.error(formatDiagnostic(path, { ...warning, kind: `warning: ${warning.kind}` }))
      }

      if (result.errors.length > 0) failed = true
      if (result.warnings.length > 0) warned = true

      const blocked = result.errors.length > 0 && (!options.force || result.output === "")

      if (options.check) continue

      const target = options.output ?? (options.write && !stdin ? convertedPath(file, to) : null)

      if (!target) {
        if (!blocked) process.stdout.write(result.output)
        continue
      }

      if (blocked) {
        console.error(`${path}: not written (use --force to write it anyway)`)
        continue
      }

      if (existsSync(target) && !options.force && !options.dryRun) {
        console.error(`${path}: ${target} already exists (use --force to overwrite it)`)
        failed = true
        continue
      }

      if (options.dryRun) {
        console.log(`${path} -> ${target}`)
      } else {
        writeFileSync(target, result.output, "utf-8")
        console.log(`${path} -> ${target}`)
      }
    }

    if (failed) return 1
    if (options.check && warned) return 1

    return 0
  }
}
