# Herb Syntax Tree Printer

**Package:** [`@herb-tools/printer`](https://www.npmjs.com/package/@herb-tools/printer)

---

AST printer infrastructure for lossless HTML+ERB reconstruction and AST-to-source code conversion for the Herb Parser Syntax Tree.

## Installation

:::code-group
```shell [npm]
npm add @herb-tools/printer
```

```shell [pnpm]
pnpm add @herb-tools/printer
```

```shell [yarn]
yarn add @herb-tools/printer
```

```shell [bun]
bun add @herb-tools/printer
```
:::

### Usage

#### IdentityPrinter (Provides lossless reconstruction of the original source)

For lossless reconstruction of the original source:

```javascript
import { IdentityPrinter } from '@herb-tools/printer'
import { Herb } from '@herb-tools/node-wasm'

await Herb.load()

const parseResult = Herb.parse(
  '<div class="hello" >  Hello  </div>',
  { track_whitespace: true }
)

const printer = new IdentityPrinter()
const output = printer.print(parseResult.value)

// output === '<div class="hello" >  Hello  </div>' (exact preservation)
```

#### Custom Printers

Create custom printers by extending the base `Printer` class and override specific visitors for custom behavior:

```typescript
import { Printer } from "@herb-tools/printer"
import { HTMLAttributeNode } from "@herb-tools/core"

class CustomPrinter extends Printer {
  protected write(content: string) {
    super.write(content.toUpperCase())
  }

  protected visitHTMLAttributeNode(node: HTMLAttributeNode) {
    // do nothing to strip attributes
  }
}
```

and then printing the result using `print`

```js
import { Herb } from "@herb-tools/node-wasm"

await Herb.load()

const parseResult = Herb.parse(
  '<div class="hello">  Hello  </div>',
  { track_whitespace: true }
)

const printer = new CustomPrinter()
const output = printer.print(parseResult.value)

// output === '<div >  HELLO  </div>'
```

#### Print Options

The printer supports options to control how nodes are printed:

```typescript
import { IdentityPrinter, DEFAULT_PRINT_OPTIONS } from "@herb-tools/printer"
import type { PrintOptions } from "@herb-tools/printer"

const printer = new IdentityPrinter()

// Will throw error if node has parse errors (default behavior)
const output1 = printer.print(nodeWithErrors)

// Will print the node despite parse errors
const output2 = printer.print(nodeWithErrors, { ignoreErrors: true })
```

When `ignoreErrors` is `false` (default), the printer will throw an error if you attempt to print a node that contains parse errors. Set `ignoreErrors` to `true` to print nodes with errors, which can be useful for debugging or partial AST reconstruction.

:::warning Important
The Printer expects the source to be parsed using the `track_whitespace: true` parser option for accurate source reconstruction.
:::

#### Converting between Slim and HTML+ERB

`ReadableERBPrinter` prints a syntax tree as idiomatic, indented HTML+ERB (one element per line, `<% if %>` ... `<% end %>`), and `SlimPrinter` prints an HTML+ERB tree as idiomatic Slim (`.card#main` shortcuts, `=` / `-` lines without `end`s, `attr=code`, `|` text, `javascript:`). `convertSlimToERB` and `convertERBToSlim` parse and print in one step, and report where the result renders differently:

```js
import { Herb } from "@herb-tools/node-wasm"
import { convertSlimToERB, convertERBToSlim } from "@herb-tools/printer"

await Herb.load()

const { output, warnings, errors } = convertSlimToERB(Herb, "a href=@url Link")
// output:   <a href="<%= @url %>">Link</a>
// warnings: [{ kind: "dynamic-attribute", line: 1, column: 7, message: "..." }]

convertERBToSlim(Herb, output).output
// a href=@url Link
```

Converting Slim to ERB and back reaches a fixed point: printing the Slim again gives the same Slim, and the same ERB.

The warnings list the readable-mode differences: `dynamic-attribute` (Slim omits `attr=nil`/`false` and renders `attr=true` bare), `dynamic-class` (Slim flattens Arrays and drops an empty `class`), `attribute-splat` (splats are Rails' `tag.attributes`, which doesn't merge `class` with the element's own classes) and `whitespace` (inline content printed on separate lines renders a space Slim doesn't). ERB that has no Slim form (control flow in attribute values or open tags, `=begin` comments, conditional open tags) is reported in `errors`.

#### CLI Usage

```bash
# Convert templates between Slim and HTML+ERB
herb-convert app/views/users/show.html.slim            # print the ERB
herb-convert --write app/views/users/show.html.slim    # write show.html.erb
herb-convert --to slim --write app/views/**/*.html.erb
herb-convert --check app/views/users/show.html.slim    # exit 1 on errors or warnings

# Basic round-trip printing
herb-print input.html.erb > output.html.erb

# Verify parser accuracy
herb-print input.html.erb --verify

# Show parsing statistics
herb-print input.html.erb --stats
```
