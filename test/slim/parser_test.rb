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

    test "explicit end" do
      assert_slim_snapshot(<<~SLIM)
        - if a
          p A
        - end
      SLIM
    end
  end
end
