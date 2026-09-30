# frozen_string_literal: true

require_relative "../test_helper"

module Diff
  class SlimDiffTest < Minitest::Spec
    SLIM = <<~SLIM
      div.card
        h1 Hello
        p.lead title="x" = @name
        - if @show
          span Shown
    SLIM

    def slim_diff(previous, current, **)
      Herb.diff(previous, current, language: "slim", exact_semantics: true, track_whitespace_changes: true, **)
    end

    def summary(result)
      result.operations.map { |operation| [operation.type, operation.path] }
    end

    test "parser options reach both parses" do
      result = Herb.diff("p Hi\n", "p Hello\n", language: "slim")

      assert_equal [[:text_changed, [0, 0]]], summary(result)
    end

    test "without a language both sides parse as ERB, as before" do
      result = Herb.diff("p Hi\n", "p Hello\n")

      assert_equal [:text_changed], result.operations.map(&:type)
      assert_equal [0], result.operations.first.path
    end

    test "an unchanged Slim template is identical" do
      assert_predicate slim_diff(SLIM, SLIM.dup), :identical?
    end

    test "edits that render the same markup are identical" do
      assert_predicate slim_diff(SLIM, SLIM.gsub(/^( +)/) { ::Regexp.last_match(1) * 2 }), :identical?
      assert_predicate slim_diff(SLIM, SLIM.sub('title="x"', "title='x'")), :identical?
      assert_predicate slim_diff(SLIM, SLIM.sub("  h1 Hello\n", "  h1 Hello\n\n")), :identical?
    end

    test "a text edit is text_changed at its element" do
      assert_equal [[:text_changed, [0, 0, 0]]], summary(slim_diff(SLIM, SLIM.sub("Hello", "World")))
    end

    test "a verbatim text edit is text_changed" do
      assert_equal [[:text_changed, [0, 0]]], summary(slim_diff("p\n  | hello there\n", "p\n  | hello world\n"))
    end

    test "an attribute edit is attribute_value_changed" do
      assert_equal [[:attribute_value_changed, [0, 1, 3]]], summary(slim_diff(SLIM, SLIM.sub('"x"', '"y"')))
    end

    test "a class or id shortcut edit is attribute_value_changed" do
      assert_equal [:attribute_value_changed], slim_diff(SLIM, SLIM.sub("p.lead", "p.lede")).operations.map(&:type)
      assert_equal [:attribute_value_changed], slim_diff("#main\n  p hi\n", "#other\n  p hi\n").operations.map(&:type)
    end

    test "an added attribute is attribute_added" do
      types = slim_diff(SLIM, SLIM.sub('title="x"', 'title="x" data-a="1"')).operations.map(&:type).uniq

      assert_equal [:attribute_added], types
    end

    test "structural edits match their ERB equivalents" do
      erb = "<div class=\"card\">\n  <h1>Hello</h1>\n  <p><%= @name %></p>\n</div>\n"
      slim = "div.card\n  h1 Hello\n  p = @name\n"

      inserted_erb = Herb.diff(erb, erb.sub("<h1>Hello</h1>\n", "<h1>Hello</h1>\n  <h2>Sub</h2>\n"))
      inserted_slim = slim_diff(slim, slim.sub("h1 Hello\n", "h1 Hello\n  h2 Sub\n"))

      assert_equal [:node_inserted, :node_inserted], inserted_erb.operations.map(&:type)
      assert_equal [[:node_inserted, [0, 1]]], summary(inserted_slim)

      removed_slim = slim_diff(slim, slim.sub("  h1 Hello\n", ""))

      assert_equal [[:node_removed, [0, 0]]], summary(removed_slim)

      erb_changed = slim_diff(slim, slim.sub("@name", "@title"))

      assert_equal [:erb_content_changed], erb_changed.operations.map(&:type)
      assert_equal [:erb_content_changed], Herb.diff(erb, erb.sub("@name", "@title")).operations.map(&:type)
    end

    test "matching doesn't depend on where a node sits in the Slim source" do
      previous = "div\n  p One\n  p Two\n"
      current = "div\n\n\n      p One\n      p Two changed\n"

      assert_equal [[:text_changed, [0, 1, 0]]], summary(slim_diff(previous, current))
    end

    test "Slim settings are honored" do
      previous = "~card Hi\n"
      current = "~card Hello\n"
      shortcuts = { "~" => "data-testid", "#" => "id", "." => "class" }

      result = slim_diff(previous, current, slim_shortcuts: shortcuts)

      assert_equal [[:text_changed, [0, 0]]], summary(result)
      assert_equal [[:attribute_value_changed, [0, 1]]], summary(slim_diff("~a Hi\n", "~b Hi\n", slim_shortcuts: shortcuts))
    end
  end
end
