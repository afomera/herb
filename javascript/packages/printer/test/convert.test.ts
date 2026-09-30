import dedent from "dedent"
import { describe, test, expect, beforeAll } from "vitest"

import { Herb } from "@herb-tools/node-wasm"
import { parserOptionsForLanguage } from "@herb-tools/core"

import { convertERBToSlim, convertSlimToERB, ReadableERBPrinter, SlimPrinter } from "../src/index.js"

import type { ConvertOptions } from "../src/index.js"

describe("Slim <=> HTML+ERB conversion", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  function toERB(slim: string, options: ConvertOptions = {}): string {
    const result = convertSlimToERB(Herb, slim, options)

    expect(result.errors).toEqual([])

    return result.output
  }

  function toSlim(erb: string, options: ConvertOptions = {}): string {
    const result = convertERBToSlim(Herb, erb, options)

    expect(result.errors).toEqual([])

    return result.output
  }

  // erb1 = toERB(T), slim2 = toSlim(erb1), erb2 = toERB(slim2), slim3 = toSlim(erb2)
  function roundTrip(slim: string, options: ConvertOptions = {}) {
    const erb1 = toERB(slim, options)
    const slim2 = toSlim(erb1, options)
    const erb2 = toERB(slim2, options)
    const slim3 = toSlim(erb2, options)

    expect(erb2).toBe(erb1)
    expect(slim3).toBe(slim2)

    return { erb1, slim2 }
  }

  test("prints Slim as readable, indented HTML+ERB", () => {
    expect(toERB(dedent`
      doctype html
      #main.card(data-id=post.id title="Post #{post.title}")
        - if admin
          p = post.body
        - elsif guest
          p Guest #{name}
        - else
          p Nobody
        ul
          - posts.each do |post|
            li: a href=post_path(post) = post.title
        / a comment
        javascript:
          var a = 1;
          alert(a);
    `)).toBe(dedent`
      <!DOCTYPE html>
      <div id="main" class="card" data-id="<%= post.id %>" title="Post <%= post.title %>">
        <% if admin %>
          <p><%= post.body %></p>
        <% elsif guest %>
          <p>Guest <%= name %></p>
        <% else %>
          <p>Nobody</p>
        <% end %>
        <ul>
          <% posts.each do |post| %>
            <li>
              <a href="<%= post_path(post) %>"><%= post.title %></a>
            </li>
          <% end %>
        </ul>
        <%# a comment %>
        <script>
          var a = 1;
          alert(a);
        </script>
      </div>
    ` + "\n")
  })

  test("prints HTML+ERB as idiomatic Slim", () => {
    expect(toSlim(dedent`
      <div class="card wide <%= extra %>" id="main">
        <% if admin %>
          <p><%= post.body %></p>
        <% else %>
          <p>Hello <b><%= name %></b>!</p>
        <% end %>
        <a href="<%= post_path(post) %>" title="Post <%= post.title %>">Read</a>
        <input type="checkbox" checked>
        <!-- note -->
        <% case status %>
        <% when :active %>
          Active
        <% end %>
        <style>p { color: red; }</style>
      </div>
    `)).toBe(dedent`
      .card.wide class="#{extra}" id="main"
        - if admin
          p = post.body
        - else
          p Hello <b>#{name}</b>!
        a> href="#{post_path(post)}" title="Post #{post.title}" Read
        input(type="checkbox" checked)
        /! note
        - case status
        - when :active
          | Active
        css:
          p { color: red; }
    ` + "\n")
  })

  test("reaches a fixed point: slim -> erb -> slim -> erb", () => {
    const templates = [
      dedent`
        ul
          li: a href="/" Home
          li.active = link_to "About", about_path
      `,
      dedent`
        p
          | Hello
          b world
        p Hello #{name}, you have #{count} items
        a> href="/a" A
        span B
      `,
      dedent`
        - case x
        - when 1
          | one
        - else
          | other
        = form_with model: post do |f|
          = f.text_field :title
        - begin
          = risky
        - rescue StandardError
          p Failed
      `,
      dedent`
        div *attrs data={ id: 1 } Content
        *{ tag: "h1", id: "t" } Title
        .alpha class=:beta,:gamma
        input checked=true disabled=false
      `,
      dedent`
        /[if IE]
          p Old browser
        /! A comment
        ruby:
          x = 1
          y = 2
        p = x + y
      `,
    ]

    for (const template of templates) roundTrip(template)
  })

  test("keeps the spaces the line breaks around inline elements render", () => {
    // text that ends a line before an inline element, and text that starts a line after one
    expect(toSlim(dedent`
      <p>
        The corner comes from
        <code>herb:state</code>. Changing it re-places the stack.
      </p>
      <p>
        The template only ever sees <code>panel</code>
        and <code>height</code>, both plain state.
      </p>
    `)).toBe(dedent`
      p
        ' The corner comes from
        code herb:state
        | . Changing it re-places the stack.
      p
        ' The template only ever sees
        code> panel
        ' and
        code height
        | , both plain state.
    ` + "\n")

    // between inline elements and output: `>` / `<` markers
    expect(toSlim(dedent`
      <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
        <%= link_to "Docs", docs_path %>
        <span>!</span>
      </nav>
    `)).toBe(dedent`
      nav
        a> href="/" Home
        a> href="/about" About
        => link_to "Docs", docs_path
        span !
    ` + "\n")

    // block elements and the ends of an element's content don't render the line breaks
    expect(toSlim(dedent`
      <div>
        Intro
        <div>Block</div>
        <code>x</code>
      </div>
    `)).toBe(dedent`
      div
        | Intro
        div Block
        code x
    ` + "\n")
  })

  test("the whitespace around inline elements survives the round trip", () => {
    const { erb1, slim2 } = roundTrip(dedent`
      p
        ' The corner comes from
        code> herb:state
        | changes it.
      p
        code panel
        |  and
        code height
      p
        a> href="/" Home
        a href="/about" About
    `)

    expect(erb1).toBe(dedent`
      <p>
        The corner comes from
        <code>herb:state</code>
        changes it.
      </p>
      <p>
        <code>panel</code>
        and
        <code>height</code>
      </p>
      <p>
        <a href="/">Home</a>
        <a href="/about">About</a>
      </p>
    ` + "\n")

    expect(slim2).toBe(dedent`
      p
        ' The corner comes from
        code> herb:state
        | changes it.
      p
        code> panel
        ' and
        code height
      p
        a> href="/" Home
        a href="/about" About
    ` + "\n")
  })

  test("prints ERB output on its own lines as one `=` line per output", () => {
    // whitespace between elements in <head> doesn't render
    expect(toSlim(dedent`
      <head>
        <%= csrf_meta_tags %>
        <%= csp_meta_tag %>
      </head>
    `)).toBe(dedent`
      head
        = csrf_meta_tags
        = csp_meta_tag
    ` + "\n")

    // elsewhere the line break renders as a space: `=>`
    expect(toSlim(dedent`
      <div>
        <%= render "a" %>
        <%= render "b" %>
      </div>
      <a href="/">
        <%= image_tag "logo.png" %>

        Home
      </a>
      <p><%= first %><%= second %> <%== third %></p>
    `)).toBe(dedent`
      div
        => render "a"
        = render "b"
      a href="/"
        => image_tag "logo.png"
        | Home
      p
        = first
        => second
        == third
    ` + "\n")

    // text around output on the same line stays a text block
    expect(toSlim(dedent`
      <p>
        Hello <%= name %>,
        welcome back
      </p>
    `)).toBe(dedent`
      p
        | Hello #{name},
          welcome back
    ` + "\n")

    roundTrip(dedent`
      head
        = csrf_meta_tags
        = csp_meta_tag
      div
        => render "a"
        = render "b"
      p
        | #{first}#{second}
    `)
  })

  test("keeps the whitespace between the iterations of a loop", () => {
    expect(toSlim(dedent`
      <p>
        <% tags.each do |tag| %>
          <%= link_to tag.name, tag %>
        <% end %>
      </p>
      <ul>
        <% items.each do |item| %>
          <li><%= item %></li>
        <% end %>
      </ul>
    `)).toBe(dedent`
      p
        - tags.each do |tag|
          => link_to tag.name, tag
      ul
        - items.each do |item|
          li = item
    ` + "\n")

    roundTrip(dedent`
      p
        - tags.each do |tag|
          = link_to tag.name, tag
        - 3.times do
          ' Hey!
    `)
  })

  test("prints ERB attribute values as a `#{}` interpolation, which renders the same", () => {
    const result = convertERBToSlim(Herb, dedent`
      <a href="<%= url %>" class="<%= classes %>" data-open="<%= panel %>" tabindex="<%= -1 %>" data-kind="<%= :note %>">Link</a>
      <input checked="<%= true %>" disabled="<%= false %>" aria-hidden="<%= true %>">
    `)

    expect(result.output).toBe(dedent`
      a> href="#{url}" class="#{classes}" data-open="#{panel}" tabindex=-1 data-kind=:note Link
      input checked=true disabled="#{false}" aria-hidden="#{true}"
    ` + "\n")

    expect(result.warnings).toEqual([])

    // Slim's `attr=code` becomes `attr="<%= code %>"` in ERB (with a warning), and `attr="#{code}"` in Slim again
    const { erb1, slim2 } = roundTrip(dedent`
      a href=@url Link
      div class=classes data-open=panel
      input checked=true
    `)

    expect(erb1).toBe(dedent`
      <a href="<%= @url %>">Link</a>
      <div class="<%= classes %>" data-open="<%= panel %>"></div>
      <input checked>
    ` + "\n")

    expect(slim2).toBe(dedent`
      a href="#{@url}" Link
      div class="#{classes}" data-open="#{panel}"
      input(checked)
    ` + "\n")
  })

  test("idiomaticAttributes prints `attr=code` and reports the difference", () => {
    const result = convertERBToSlim(Herb, `<a href="<%= url %>" class="<%= classes %>" tabindex="<%= 1 %>">Link</a>`, { idiomaticAttributes: true })

    expect(result.output).toBe(`a href=url class=classes tabindex=1 Link\n`)
    expect(result.warnings.map(warning => `${warning.line}:${warning.column} ${warning.kind}`)).toEqual([
      "1:9 dynamic-attribute",
      "1:28 dynamic-class",
    ])
    expect(result.warnings[0].message).toContain("changes what renders")

    roundTrip(`a href=@url class=classes Link`, { idiomaticAttributes: true })
  })

  test("prints strict locals as `/# locals:`", () => {
    expect(toSlim(dedent`
      <%# locals: (album:, size: :small) %>
      <%# a note %>
      <p><%= album.title %></p>
    `)).toBe(dedent`
      /# locals: (album:, size: :small)
      / a note
      p = album.title
    ` + "\n")

    const { erb1, slim2 } = roundTrip(dedent`
      /# locals: (album:)
      p = album.title
    `)

    expect(erb1).toBe("<%# locals: (album:) %>\n<p><%= album.title %></p>\n")
    expect(slim2).toBe("/# locals: (album:)\np = album.title\n")
  })

  test("prints configured shortcuts back", () => {
    const options = { slimParserOptions: parserOptionsForLanguage("slim", { slim: { shortcuts: { "~": { attr: "data-testid" }, "#": { attr: "id" }, ".": { attr: "class" } }, merge_attrs: { class: " ", "data-controller": " " } } }) }
    const { erb1, slim2 } = roundTrip(dedent`
      div.some-class~this-element-test-id Hello
      .a data-controller="x" data-controller="y" Merged
    `, options)

    expect(erb1).toBe(dedent`
      <div class="some-class" data-testid="this-element-test-id">Hello</div>
      <div class="a" data-controller="x y">Merged</div>
    ` + "\n")

    expect(slim2).toBe(dedent`
      .some-class~this-element-test-id Hello
      .a data-controller="x y" Merged
    ` + "\n")
  })

  test("reports readable-mode semantic differences with their locations", () => {
    const result = convertSlimToERB(Herb, dedent`
      a href=@url title="static" Link
      span class=classes
      div *attrs
      a A
      span B
      - 3.times do
        | Hey!
    `)

    expect(result.warnings.map(warning => `${warning.line}:${warning.column} ${warning.kind}`)).toEqual([
      "1:7 dynamic-attribute",
      "2:0 whitespace",
      "2:11 dynamic-class",
      "3:4 attribute-splat",
      "5:0 whitespace",
      "6:0 whitespace",
    ])
  })

  test("literal ERB delimiters in Slim text are escaped", () => {
    expect(toERB("p a <% b %> c")).toBe("<p>a &lt;% b %&gt; c</p>\n")
    expect(toERB(dedent`
      javascript:
        var a = "<%";
    `)).toBe(dedent`
      <script>var a = "<%== "<" + "%" %>";</script>
    ` + "\n")
  })

  test("reports ERB that has no Slim form", () => {
    const result = convertERBToSlim(Herb, `<div class="<% if a %>b<% end %>" <%= attributes %>>x</div>`)

    expect(result.errors.map(error => error.kind)).toEqual(["unsupported-erb", "unsupported-erb"])
    expect(result.output).toBe("div x\n")
  })

  test("the printers can be used directly", () => {
    const slim = Herb.parse("p = name", { language: "slim" })
    const erb = Herb.parse("<p><%= name %></p>")

    expect(new ReadableERBPrinter().print(slim)).toBe("<p><%= name %></p>\n")
    expect(new SlimPrinter().print(erb)).toBe("p = name\n")
  })
})
