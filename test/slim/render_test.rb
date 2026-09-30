# frozen_string_literal: true

require_relative "slim_test_helper"

module Slim
  # Round-trip oracle: every template is rendered by the slim gem, and the HTML+ERB printed from
  # Herb's tree (`Herb.parse(source, language: "slim")`) is rendered by ActionView. Both outputs
  # must be the same HTML (attribute order and entity encoding are normalized).
  class RenderTest < Minitest::Spec
    include SlimTestSupport::TestHelper

    LOCALS = {
      name: "Ada <Lovelace>",
      admin: true,
      guest: false,
      items: [{ title: "One", url: "/one" }, { title: "Two & Three", url: "/two" }],
      count: 3,
      status: :active,
      html: "<em>raw</em>",
      css_class: "highlight",
      nothing: nil,
      classes: ["one", ["two", nil], ""],
    }.freeze

    CORPUS = {
      "tags and nesting" => <<~SLIM,
        html
          head
            title Page
          body
            div
              p Hello
              p World
      SLIM

      "id and class shortcuts with implicit div" => <<~SLIM,
        #main.container.wide
          .inner Hello
          span#label.a.b Text
      SLIM

      "inline nesting" => <<~SLIM,
        ul
          li: a href="/one" One
          li.item: span: b Deep
      SLIM

      "void elements and trailing slash" => <<~SLIM,
        br
        img src="/a.png" alt="A"
        input type="text" name="q"
        div/
      SLIM

      "quoted attributes with interpolation" => <<~'SLIM',
        a href="/users/#{name}" title='Name: #{name}' Link
        div data-count="#{count} items" class="static"
      SLIM

      "ruby attributes" => <<~SLIM,
        a href=items.first[:url] class=css_class = items.first[:title]
        div data-name=name.upcase data-count=(count + 1)
      SLIM

      "boolean attributes in wrappers" => <<~SLIM,
        input(type="checkbox" checked disabled)
        option[selected value="1"] One
        button{disabled type="submit"} Save
      SLIM

      "true false and nil attribute values" => <<~SLIM,
        input type="checkbox" checked=true disabled=false readonly=nil
      SLIM

      "multi-line wrapped attributes" => <<~SLIM,
        a(href="/x"
          class="link"
          title=name) Multi
      SLIM

      "class merging" => <<~SLIM,
        .a.b class="c" Merged
        span.d class=css_class Dynamic
      SLIM

      "text blocks" => <<~SLIM,
        p
          | Hello
            world
             indented
        p
          ' Trailing space
        p
          | First
          | Second
      SLIM

      "text with interpolation" => <<~'SLIM',
        p Hello #{name}, you have #{count} items
        p Raw #{{html}}
        p Escaped \#{not_interpolated}
      SLIM

      "inline html" => <<~SLIM,
        <div class="wrapper">
          p Inside
        </div>
        <br>
      SLIM

      "output code" => <<~SLIM,
        = name
        == html
        p = name
        p == html
        span = count * 2
      SLIM

      "control code with if else" => <<~SLIM,
        - if admin
          p Admin
        - elsif guest
          p Guest
        - else
          p Nobody
      SLIM

      "unless" => <<~SLIM,
        - unless guest
          p Not a guest
      SLIM

      "case when" => <<~SLIM,
        - case status
        - when :active
          p Active
        - when :inactive
          p Inactive
        - else
          p Unknown
      SLIM

      "each block" => <<~SLIM,
        ul
          - items.each do |item|
            li
              a href=item[:url] = item[:title]
      SLIM

      "each with index and nested if" => <<~SLIM,
        - items.each_with_index do |item, index|
          - if index.zero?
            b = item[:title]
          - else
            i = item[:title]
      SLIM

      "implicit do" => <<~SLIM,
        - 2.times
          p Twice
      SLIM

      "begin rescue" => <<~SLIM,
        - begin
          p = Integer("x")
        - rescue ArgumentError
          p Rescued
      SLIM

      "while loop" => <<~SLIM,
        - i = 0
        - while i < 2
          p = i
          - i += 1
      SLIM

      "line continuation" => <<~SLIM,
        = [name,
          count].join(" / ")
        - total = [count,
          1].sum
        p = total
      SLIM

      "local assignment and output" => <<~SLIM,
        - greeting = "Hi"
        p = greeting + " " + name
      SLIM

      "comments" => <<~SLIM,
        / This is a Slim comment
          that spans lines
        p Visible
        /! An HTML comment
      SLIM

      "doctype" => <<~SLIM,
        doctype html
        html
          body Hi
      SLIM

      "embedded javascript and css" => <<~'SLIM',
        javascript:
          var count = #{count};
          console.log("hi");
        css:
          .a { color: red; }
      SLIM

      "whitespace markers" => <<~SLIM,
        a> href="/a" A
        a< href="/b" B
        span Text
        =< name
        => name
      SLIM

      "attribute splat" => <<~SLIM,
        div *{ title: name, "data-count" => count } Splat
      SLIM

      "dynamic attribute values: nil, false, true and strings" => <<~SLIM,
        a href=nothing title=guest data-flag=admin data-name=name Link
        input value=name.upcase disabled=admin readonly=(guest || nil)
        a href=items.first[:url] data-count=count Count
      SLIM

      "dynamic class values: arrays, nil and false" => <<~'SLIM',
        div class=classes
        div class=nothing
        .a class=classes
        .a class=nothing
        span class=["x", nil, ["y", ""]]
        span class=guest
        span class="static #{nothing}"
      SLIM

      "static attribute values are escaped" => <<~SLIM,
        a title='say "hi" & <bye>' href="/x?a=1&b=2" Escaped
        a data-raw=="<b>raw</b>" Raw
      SLIM

      "inline html with a Slim body" => <<~'SLIM',
        <section class="wrap" data-x="1">
          p Inside
          <b>bold</b>
        </section>
        <br>
        <p>#{name}</p>
      SLIM

      "literal ERB openers in text" => <<~SLIM,
        p Text with <% not erb %> and <%= neither %>
        | <%
        javascript:
          var a = "<%";
      SLIM

      "embedded ruby" => <<~SLIM,
        ruby:
          greeting = "Hi"
          shout = greeting.upcase +
            "!"
        p = shout
      SLIM

      "attribute splat merged with shortcuts and attributes" => <<~SLIM,
        #main.a *{ class: ["b", "c"], "data-x" => name, disabled: true, hidden: false, title: nothing } Splat
        a.link href="/x" *{ class: "extra", target: "_blank" } Link
      SLIM

      "dynamic tags" => <<~SLIM,
        *{ tag: "h1", id: "title" } Title
        *{ tag: "section", class: "box" }
          p Body
        *{ tag: "img", src: "/a.png" } /
        *{ id: "default" } Default div
      SLIM

      "data and aria hashes" => <<~SLIM,
        div data={ a: "x", c: { e: name } } aria={ label: "L" } Data
        div data-plain="1" data=nothing Plain
      SLIM

      "attributes are evaluated once" => <<~SLIM,
        - counter = [0]
        input value=(counter[0] += 1)
        input value=counter.push(counter.last + 1).last
      SLIM

      "output with only a comment as content" => <<~SLIM,
        = name
          / just a comment
      SLIM

      "class comma list" => <<~SLIM,
        .alpha class=:beta,:gamma Classes
      SLIM

      "conditional comment" => <<~SLIM,
        /[if IE]
          p Old browser
      SLIM
    }.freeze

    test "byte order mark is ignored" do
      assert_slim_renders_like_erb("\uFEFFp BOM", LOCALS)
    end

    test "omitted attributes leave no stray whitespace" do
      skip SlimTestSupport.render_dependency_error if SlimTestSupport.render_dependency_error

      erb = slim_to_erb("option selected=guest value=nothing class=nothing Opt")

      assert_equal "<option>Opt</option>", render_erb(erb, LOCALS)
      assert_equal "<option>Opt</option>", render_slim("option selected=guest value=nothing class=nothing Opt", LOCALS)
    end

    CORPUS.each do |description, source|
      test description do
        assert_slim_renders_like_erb(source, LOCALS)
      end
    end
  end
end
