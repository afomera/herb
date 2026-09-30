# Herb Dev Server

The Herb Dev Server watches template files and provides real-time hot-reloading during development via WebSocket.

> [!WARNING]
> The dev server is experimental and may not work correctly in all cases.

## Usage

```bash
herb dev [directory] [--port 8592]
```

The server starts watching all template files in the directory, diffs changes using the Herb diff engine, and broadcasts updates to connected clients.

## How It Works

1. **File watching**: monitors all `.html.erb`, `.html.herb`, and other template files for changes
2. **AST diffing**: when a file changes, diffs the old and new AST to determine what changed
3. **Smart patching**: for text and attribute changes, sends a patch that the client applies without reloading
4. **Reload fallback**: for structural changes (insertions, removals, ERB changes), tells the client to reload

### Slim templates

`.slim` files are watched too. They are parsed as Slim with the project's Slim settings, so a parse error shows in the browser at its Slim line. An edit is diffed as Slim with [`exact_semantics`](/parser-options#exact-semantics), the tree `Herb::Engine` compiles the template from, so it is classified the way the equivalent ERB edit is: a text or attribute change is patched in place, an edit that renders the same markup (a reindent, a blank line, `'` for `"`, `p.a` for `p class="a"`) does nothing, and everything else refetches. The host's compiler is asked for a Slim template's slot schema like an ERB one's, so with [ReActionView](https://reactionview.dev) and `config.intercept_slim` a Slim page gets the same in-place patches as an ERB page. Without a host that compiles slots, a page that rendered the template reloads (one carrying its [debug markers](/projects/engine#slim-in-rails)).

`Herb.diff` takes parser options for this, so a Slim pair can be diffed directly:

```ruby
Herb.diff(before, after, language: "slim", exact_semantics: true, **Herb.configuration.slim_parser_options)
```

## Architecture

The dev server consists of two parts:

- **Server** (`lib/herb/dev/`): Ruby WebSocket server that watches files and broadcasts changes
- **Client** (part of `@herb-tools/dev-tools`): connects to the server and applies DOM patches

## CLI Output

```
 🌿 Herb Dev Server

  ⚠️ Experimental: The dev server is experimental and may not work correctly in all cases.

  Herb:      0.11.0
  Project:   /path/to/project
  Config:    .herb.yml
  Files:     453 templates indexed
  WebSocket: ws://localhost:8592

  Ready! Watching for changes...

  Recent changes:

    20:13:40 ✓ patch  app/views/posts/show.html.erb (1 operation) [1 client]
                      #1 text changed [4, 8]
    20:13:45 ↻ reload app/views/posts/index.html.erb (2 operations) [1 client]
                      #1 node inserted [0, 3]
                      #2 text changed [0, 4]
```

## Links

- [Dev Tools (`@herb-tools/dev-tools`)](/projects/dev-tools)
