"use strict"

// Runs a bin from one of the @herb-tools packages bundled inside this package.
// The bundled copies live in this package's own node_modules, so the registry
// releases of @herb-tools/* are never picked up.

const fs = require("node:fs")
const path = require("node:path")
const { pathToFileURL } = require("node:url")

module.exports = function run(packageName, binName) {
  const packageRoot = path.resolve(__dirname, "..")
  const packageDirectory = path.join(
    packageRoot,
    "node_modules",
    ...packageName.split("/"),
  )
  const manifestPath = path.join(packageDirectory, "package.json")

  if (!fs.existsSync(manifestPath)) {
    console.error(
      `herb-slim-preview: bundled package ${packageName} is missing (${manifestPath})`,
    )
    process.exit(1)
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  const binPath =
    typeof manifest.bin === "string"
      ? manifest.bin
      : manifest.bin && manifest.bin[binName]

  if (!binPath) {
    console.error(
      `herb-slim-preview: ${packageName} does not provide the ${binName} bin`,
    )
    process.exit(1)
  }

  return import(pathToFileURL(path.join(packageDirectory, binPath)).href)
}
