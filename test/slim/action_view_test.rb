# frozen_string_literal: true

require_relative "slim_test_helper"

module Slim
  # ActionView tag helpers (`action_view_helpers: true`) are transformed into HTML elements for Slim
  # templates too, through the Ruby program the Slim frontend hands to the analyzer.
  class ActionViewTest < Minitest::Spec
    include SnapshotUtils
    include SlimTestSupport::TestHelper

    LOCALS = { path: "/posts/1", name: "Ada" }.freeze

    CORPUS = {
      "link_to" => <<~SLIM,
        = link_to "x", path
      SLIM

      "link_to with block" => <<~'SLIM',
        = link_to path do
          span Hi #{name}
      SLIM

      "content_tag with block" => <<~SLIM,
        = content_tag :div, class: "a" do
          p Inside
      SLIM

      "tag.div with block" => <<~SLIM,
        = tag.div class: "x" do
          b Bold
      SLIM

      "image_tag" => <<~SLIM,
        = image_tag "a.png"
      SLIM

      "helpers nested in tags and control flow" => <<~'SLIM',
        ul
          - [1, 2].each do |id|
            li = link_to "Item #{id}", "/items/#{id}", class: "item"
      SLIM
    }.freeze

    CORPUS.each do |description, source|
      test "#{description} is transformed" do
        result = assert_parsed_snapshot(source, language: "slim", action_view_helpers: true)

        assert_empty result.errors.map(&:message)
      end

      test "#{description} renders like the slim gem" do
        assert_slim_renders_like_erb(source, LOCALS, action_view_helpers: true)
      end
    end

    test "helpers are transformed into elements" do
      result = parse_slim(CORPUS["link_to with block"], action_view_helpers: true)
      element = result.value.children.first

      assert_instance_of Herb::AST::HTMLElementNode, element
      assert_equal "a", element.tag_name.value
      assert_equal "ActionView::Helpers::UrlHelper#link_to", element.element_source
    end
  end
end
