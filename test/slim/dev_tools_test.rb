# frozen_string_literal: true

require_relative "slim_test_helper"
require_relative "../../lib/herb/engine"
require_relative "../../lib/herb/engine/visitors/debug_visitor"
require_relative "../../lib/herb/engine/visitors/instrumentation_visitor"

module Slim
  # The dev tools read what `DebugVisitor` and `InstrumentationVisitor` compile into a page. For a Slim
  # template that has to name the Slim file and the Slim line and column, and show what the author wrote.
  class DevToolsTest < Minitest::Spec
    include SnapshotUtils
    include SlimTestSupport::TestHelper

    FILENAME = "app/views/posts/_card.html.slim"

    SOURCE = <<~'SLIM'
      .card
        h1 = title
        p Hello #{name}
        p == raw_html
        p Raw #{{raw_html}}
    SLIM

    def rendered(source = SOURCE, filename: FILENAME, **locals)
      engine = Herb::Engine.new(source, filename: filename, escape: true, visitors: [Herb::Engine::DebugVisitor.new])
      scope = Object.new.instance_eval { binding }

      { title: "Hi", name: "Ada", raw_html: "<b>x</b>" }.merge(locals).each { |key, value| scope.local_variable_set(key, value) }

      Nokogiri::HTML5.fragment(scope.eval(engine.src))
    end

    def outputs(fragment)
      fragment.css("[data-herb-debug-outline-type='erb-output']")
    end

    before do
      skip SlimTestSupport.render_dependency_error if SlimTestSupport.render_dependency_error
    end

    test "the root element names the Slim template" do
      root = rendered.at_css(".card")

      assert_equal "partial", root["data-herb-debug-outline-type"]
      assert_equal "_card.html.slim", root["data-herb-debug-file-name"]
      assert_equal FILENAME, root["data-herb-debug-file-relative-path"]
    end

    test "outputs point at their Slim line and column" do
      positions = outputs(rendered).map { |span| [span["data-herb-debug-line"], span["data-herb-debug-column"]] }

      assert_equal [["2", "6"], ["3", "11"], ["4", "5"], ["5", "9"]], positions
    end

    test "outputs show the Slim that wrote them" do
      written = outputs(rendered).map { |span| span["data-herb-debug-erb"] }

      assert_equal ["= title", "\#{name}", "== raw_html", "\#{{raw_html}}"], written
    end

    test "the markup renders as it does without the markers" do
      spans = outputs(rendered)

      assert_equal ["Hi", "Ada", "<b>x</b>", "<b>x</b>"], spans.map(&:inner_html)
    end

    test "a Slim component is named after its class" do
      root = rendered(".card = title\n", filename: "app/components/admin/card/component.html.slim").at_css(".card")

      assert_equal "component", root["data-herb-debug-outline-type"]
      assert_equal "Admin::Card", root["data-herb-debug-file-name"]
    end

    test "instrumentation records Slim positions and keeps == raw" do
      engine = assert_compiled_snapshot(
        SOURCE,
        filename: FILENAME,
        escape: true,
        visitors: [Herb::Engine::InstrumentationVisitor.new(capture_output: true)]
      )

      scope = Object.new.instance_eval { binding }
      { title: "Hi", name: "Ada", raw_html: "<b>x</b>" }.each { |key, value| scope.local_variable_set(key, value) }

      assert_equal %(<div class="card"><h1>Hi</h1><p>Hello Ada</p><p><b>x</b></p><p>Raw <b>x</b></p></div>), scope.eval(engine.src)
    end
  end
end
