import dedent from "dedent"
import { describe, test, expect, beforeAll } from "vitest"

import { Herb } from "@herb-tools/node-wasm"
import { IdentityPrinter } from "../src/index.js"

describe("IdentityPrinter with Slim templates", () => {
  beforeAll(async () => {
    await Herb.load()
  })

  function print(source: string): string {
    const result = Herb.parse(source, { language: "slim" })

    expect(result.errors).toHaveLength(0)

    return new IdentityPrinter().print(result.value!)
  }

  test("prints the equivalent HTML+ERB of a Slim template", () => {
    const output = print(dedent`
      doctype html
      #main.card(data-id=post.id title="Post #{post.title}")
        - if admin
          p = post.body
        - else
          p Guest
        ul
          - posts.each do |post|
            li: a href=post_path(post) = post.title
    `)

    expect(output).toBe(
      `<!DOCTYPE html><div id="main" class="card" data-id="<%=post.id%>" title="Post <%=post.title%>">` +
        `<%if admin%><p><%=post.body%></p><%else%><p>Guest</p><% end %>` +
        `<ul><%posts.each do |post|%><li><a href="<%=post_path(post)%>"><%=post.title%></a></li><% end %></ul></div>`,
    )
  })

  test("exact_semantics lowers Slim's attribute semantics into the tree", () => {
    const result = Herb.parse("a href=post_path(post) Link", { language: "slim", exact_semantics: true })

    expect(result.errors).toHaveLength(0)
    expect(new IdentityPrinter().print(result.value!)).toBe(
      `<a <% if (_slim_href = post_path(post)) == true %> href<% elsif _slim_href %> href="<%= _slim_href %>"<% end %>>Link</a>`,
    )
  })

  test("printed ERB parses back without errors", () => {
    const output = print(dedent`
      .a.b class="c"
        | Hello #{name}
        br
        img src="/a.png"/
        a href=@url class=classes title='a "b"'
        <section>
          p Inside
        </section>
        | literal <% text
    `)

    expect(Herb.parse(output).errors).toHaveLength(0)
  })
})
