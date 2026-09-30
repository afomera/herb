# frozen_string_literal: true

require_relative "slim_test_helper"

module Slim
  class ParserTest < Minitest::Spec
    include SnapshotUtils
    include SlimTestSupport::TestHelper

    def assert_slim_snapshot(source, **)
      assert_parsed_snapshot(source, language: "slim", **)
    end

    test "empty template" do
      assert_slim_snapshot("")
    end

    test "tag with text" do
      assert_slim_snapshot("p Hello")
    end

    test "nested tags" do
      assert_slim_snapshot(<<~SLIM)
        ul
          li One
          li Two
      SLIM
    end

    test "implicit div with id and classes" do
      assert_slim_snapshot("#main.a.b Content")
    end

    test "inline nesting" do
      assert_slim_snapshot("li: a href=\"/\" Home")
    end

    test "void element and self-closing tag" do
      assert_slim_snapshot(<<~SLIM)
        br
        img src="/a.png"
        div/
      SLIM
    end

    test "quoted attribute with interpolation" do
      assert_slim_snapshot(%(a href="/users/\#{user.id}" Profile))
    end

    test "ruby attribute values" do
      assert_slim_snapshot(<<~SLIM)
        a href=user_path(user) data-id==user.id Link
      SLIM
    end

    test "boolean attributes and literal values" do
      assert_slim_snapshot(<<~SLIM)
        input(type="checkbox" checked)
        input checked=true disabled=false
      SLIM
    end

    test "multi-line attribute wrapper" do
      assert_slim_snapshot(<<~SLIM)
        a(href="/x"
          title="y") Link
      SLIM
    end

    test "class merging" do
      assert_slim_snapshot(%(.a class="b" class=c))
    end

    test "attribute splat" do
      assert_slim_snapshot("div *attributes Content")
    end

    test "text block" do
      assert_slim_snapshot(<<~'SLIM')
        | Hello
          world #{name}
      SLIM
    end

    test "text with trailing whitespace marker" do
      assert_slim_snapshot("' Hello")
    end

    test "raw and escaped interpolation" do
      assert_slim_snapshot('p #{{raw}} \#{literal} #{escaped}')
    end

    test "inline html" do
      assert_slim_snapshot(<<~SLIM)
        <div>
          p Inside
        </div>
      SLIM
    end

    test "output code" do
      assert_slim_snapshot(<<~SLIM)
        = name
        == raw
      SLIM
    end

    test "if elsif else" do
      assert_slim_snapshot(<<~SLIM)
        - if a
          p A
        - elsif b
          p B
        - else
          p C
      SLIM
    end

    test "case with sibling when branches" do
      assert_slim_snapshot(<<~SLIM)
        - case x
        - when 1
          p One
        - else
          p Other
      SLIM
    end

    test "case with nested when branches" do
      assert_slim_snapshot(<<~SLIM)
        - case x
          - when 1
            p One
          - else
            p Other
      SLIM
    end

    test "block with arguments" do
      assert_slim_snapshot(<<~SLIM)
        - items.each do |item|
          li = item
      SLIM
    end

    test "brace block with explicit closing brace" do
      assert_slim_snapshot(<<~SLIM)
        - items.each { |item|
          li = item
        - }
      SLIM
    end

    test "implicit do" do
      assert_slim_snapshot(<<~SLIM)
        - 3.times
          p Hi
      SLIM
    end

    test "output with block" do
      assert_slim_snapshot(<<~SLIM)
        = form_with model: post do |f|
          = f.text_field :title
      SLIM
    end

    test "begin rescue ensure" do
      assert_slim_snapshot(<<~SLIM)
        - begin
          = risky
        - rescue StandardError
          p Failed
        - ensure
          p Done
      SLIM
    end

    test "broken lines" do
      assert_slim_snapshot(<<~SLIM)
        = link_to "x",
          path
      SLIM
    end

    test "slim and html comments" do
      assert_slim_snapshot(<<~SLIM)
        / Slim comment
        /! HTML comment
      SLIM
    end

    test "doctypes" do
      assert_slim_snapshot(<<~SLIM)
        doctype html
        doctype xml
      SLIM
    end

    test "embedded javascript and css" do
      assert_slim_snapshot(<<~'SLIM')
        javascript:
          alert("#{message}");
        css:
          p { color: red; }
      SLIM
    end

    test "whitespace markers" do
      assert_slim_snapshot(<<~SLIM)
        a> href="/" A
        =< name
      SLIM
    end

    test "analyze: false keeps flat ERB nodes" do
      assert_slim_snapshot(<<~SLIM, analyze: false)
        - if a
          p A
      SLIM
    end

    test "dynamic attribute values" do
      assert_slim_snapshot("a href=@url title=post.title(true) data-raw==html Link")
    end

    test "dynamic class values" do
      assert_slim_snapshot(<<~SLIM)
        .a class=extra
        span class=classes
      SLIM
    end

    test "escaped static attribute values" do
      assert_slim_snapshot(%(a title='a "b" & <c>' data-raw=="<b>" Link))
    end

    test "inline html with a Slim body" do
      assert_slim_snapshot(<<~SLIM)
        <section class="wrap">
          p Inside
        </section>
      SLIM
    end

    test "literal ERB opener in text" do
      assert_slim_snapshot("p a <% b")
    end

    test "embedded ruby" do
      assert_slim_snapshot(<<~SLIM)
        ruby:
          x = 1
        p = x
      SLIM
    end

    test "attribute splat with shortcuts" do
      assert_slim_snapshot("#a.b *attrs Content")
    end

    test "dynamic tag" do
      assert_slim_snapshot(<<~SLIM)
        *{ tag: "h1" } Title
        *attrs /
      SLIM
    end

    test "data hash attribute" do
      assert_slim_snapshot("div data={ id: 1 } Content")
    end

    test "byte order mark" do
      assert_slim_snapshot("\uFEFFp BOM")
    end

    test "language option is exposed on the parse result" do
      assert_equal "slim", parse_slim("p Hi").options.language
      assert_equal "erb", Herb.parse("<p>Hi</p>").options.language
    end

    test "language accepts symbols and rejects unknown values" do
      assert_equal "slim", Herb.parse("p Hi", language: :slim).options.language
      assert_raises(ArgumentError) { Herb.parse("p Hi", language: "haml") }
    end

    test "one-line case when" do
      assert_slim_snapshot(<<~SLIM)
        - case x when 1
          p One
        - when 2
          p Two
      SLIM
    end

    test "heredoc in embedded ruby" do
      assert_slim_snapshot(<<~SLIM)
        ruby:
          message = <<~MSG
            Hi
          MSG
        p = message
      SLIM
    end

    test "legacy doctypes and xml encoding" do
      assert_slim_snapshot(<<~SLIM)
        doctype strict
        doctype frameset
        doctype transitional
        doctype xml ISO-8859-1
      SLIM
    end

    test "source-faithful tree: printed ERB keeps Ruby values as ERB output" do
      erb = slim_to_erb(<<~SLIM)
        a.link href=@url class=extra data={ id: 1 } *attrs Link
        *{ tag: "h1", id: "t" } Title
      SLIM

      assert_equal(
        %(<a class="link <%=extra%>" href="<%=@url%>" <%= tag.attributes(data: { id: 1 }) %> ) +
          %(<%= tag.attributes(**attrs) %>>Link</a><h1 <%= tag.attributes(**{ id: "t" }) %>>Title</h1>),
        erb
      )
    end

    test "strict locals magic comment" do
      assert_slim_snapshot(<<~SLIM, strict_locals: true)
        /# locals: (title:, count: 0)
        p = title
      SLIM
    end

    test "a plain comment starting with locals: is not strict locals, like in Rails" do
      result = parse_slim("/ locals: (title:)\np = title", strict_locals: true)

      assert_instance_of Herb::AST::ERBCommentNode, result.value.children.first
    end

    test "class comma list" do
      assert_equal %(<div class="alpha <%=[:beta,:gamma]%>">Classes</div>), slim_to_erb(".alpha class=:beta,:gamma Classes")
    end

    test "printed ERB" do
      erb = slim_to_erb(<<~SLIM)
        #main.a
          - if admin
            p = name
          - else
            p Guest
      SLIM

      assert_equal %(<div id="main" class="a"><%if admin%><p><%=name%></p><%else%><p>Guest</p><% end %></div>), erb
    end
  end

  # `exact_semantics: true` lowers Slim's runtime semantics into the tree (for exact HTML rendering).
  class ExactSemanticsTest < Minitest::Spec
    include SnapshotUtils
    include SlimTestSupport::TestHelper

    def assert_exact_snapshot(source)
      assert_parsed_snapshot(source, language: "slim", exact_semantics: true)
    end

    test "dynamic attribute values" do
      assert_exact_snapshot("a href=@url title=post.title(true) data-raw==html Link")
    end

    test "dynamic class values" do
      assert_exact_snapshot(<<~SLIM)
        .a class=extra
        span class=classes
      SLIM
    end

    test "attribute splat with shortcuts" do
      assert_exact_snapshot("#a.b *attrs Content")
    end

    test "dynamic tag" do
      assert_exact_snapshot(<<~SLIM)
        *{ tag: "h1" } Title
        *attrs /
      SLIM
    end

    test "data hash attribute" do
      assert_exact_snapshot("div data={ id: 1 } Content")
    end

    test "literal ERB opener in text" do
      assert_exact_snapshot("p a <% b")
    end

    test "option is exposed on the parse result" do
      assert parse_slim("p Hi", exact_semantics: true).options.exact_semantics
      refute parse_slim("p Hi").options.exact_semantics
    end

    test "printed ERB lowers nil and true attribute values" do
      erb = slim_to_erb("a href=@url Link", exact_semantics: true)

      assert_equal %(<a<% if @url == true %> href<% elsif @url %> href="<%= @url %>"<% end %>>Link</a>), erb
    end
  end

  # `slim_shortcuts` and `slim_merge_attrs` (Slim's `shortcut` and `merge_attrs` options).
  class ConfiguredParserTest < Minitest::Spec
    include SnapshotUtils
    include SlimTestSupport::TestHelper

    OPTIONS = {
      slim_shortcuts: { "~" => "data-testid", "#" => "id", "." => "class" },
      slim_merge_attrs: { "class" => " ", "data-controller" => " " },
    }.freeze

    test "data-testid shortcut" do
      assert_parsed_snapshot("div.some-class~this-element-test-id Hello", language: "slim", **OPTIONS)
    end

    test "stacked data-controller values" do
      assert_parsed_snapshot(%(div data-controller="a" data-controller=b Hi), language: "slim", **OPTIONS)
    end

    test "stacked data-controller values with exact semantics" do
      assert_parsed_snapshot(%(div data-controller="a" data-controller=b Hi), language: "slim", exact_semantics: true, **OPTIONS)
    end

    test "printed ERB" do
      erb = slim_to_erb(<<~SLIM, **OPTIONS)
        .a~t data-controller="x" data-controller="y" data-controller=z Hi
      SLIM

      assert_equal %(<div class="a" data-testid="t" data-controller="x y <%=z%>">Hi</div>), erb
    end

    test "duplicate attributes that aren't merged are still an error" do
      result = parse_slim(%(div data-controller="a" data-controller="b"))

      assert_equal ["Duplicate attribute"], result.errors.map { _1.message[/\A[^.]+/] }
    end

    test "the options replace the default shortcuts" do
      erb = slim_to_erb("~a.b", slim_shortcuts: { "~" => "data-testid" })

      assert_equal %(<div data-testid="a">.b</div>), erb
    end

    test "tag shortcuts, multiple attributes and additional attributes" do
      erb = slim_to_erb(<<~SLIM, slim_shortcuts: { "@" => "tag:section role", "&" => "class role", "^" => "tag:script data-x type=application/json", "c" => "tag:container" })
        @main A
        &admin B
        ^x C
        c D
      SLIM

      assert_equal(
        %(<section role="main">A</section><div class="admin" role="admin">B</div>) +
          %(<script data-x="x" type="application/json">C</script><container>D</container>),
        erb
      )
    end

    test "invalid shortcut configuration is reported" do
      result = parse_slim("p", slim_shortcuts: { "a" => "id", "~" => "" })

      assert_equal 2, result.errors.size
    end

    test "options are exposed on the parse result" do
      options = parse_slim("p", **OPTIONS).options

      assert_equal({ "~" => "data-testid", "#" => "id", "." => "class" }, options.slim_shortcuts)
      assert_equal({ "class" => " ", "data-controller" => " " }, options.slim_merge_attrs)
      assert_equal({ "#" => "id", "." => "class" }, parse_slim("p").options.slim_shortcuts)
    end
  end

  class ParserErrorsTest < Minitest::Spec
    include SnapshotUtils

    def assert_slim_snapshot(source, **)
      assert_parsed_snapshot(source, language: "slim", **)
    end

    test "unexpected indentation" do
      assert_slim_snapshot(<<~SLIM)
        img/
          span Nested
      SLIM
    end

    test "malformed indentation" do
      assert_slim_snapshot(<<~SLIM)
        div
            p One
          p Two
      SLIM
    end

    test "unknown line indicator" do
      assert_slim_snapshot("? what")
    end

    test "unclosed attribute wrapper" do
      assert_slim_snapshot("a(href=\"/x\"")
    end

    test "unsupported embedded engine" do
      assert_slim_snapshot(<<~SLIM)
        markdown:
          # Title
        p After
      SLIM
    end

    test "ruby syntax error" do
      assert_slim_snapshot(<<~SLIM)
        - if a +
        p = (
      SLIM
    end

    test "duplicate attribute" do
      assert_slim_snapshot(%(#a id="b" Duplicate))
    end

    test "illegal shortcut" do
      assert_slim_snapshot(<<~SLIM)
        .#test
        div.#test
      SLIM
    end

    test "unsupported dynamic tag with extra attributes" do
      assert_slim_snapshot("*attrs.merge(a: 1) title=\"x\" Content")
    end

    test "explicit end" do
      assert_slim_snapshot(<<~SLIM)
        - if a
          p A
        - end
      SLIM
    end
  end
end
