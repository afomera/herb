# frozen_string_literal: true

require_relative "slim_test_helper"

module Slim
  # `Herb::ActionView::SlimHandler` renders `.slim` templates in Action View through `Herb::Engine`.
  class SlimHandlerTest < Minitest::Spec
    include SlimTestSupport::TestHelper

    class ShoutVisitor < Herb::Visitor
      def visit_html_text_node(node)
        node.content.upcase!
        super
      end
    end

    before do
      skip SlimTestSupport.render_dependency_error if SlimTestSupport.render_dependency_error

      require_relative "../../lib/herb/action_view/slim_handler"
      Herb::ActionView::SlimHandler.reset!
    end

    after do
      Herb::ActionView::SlimHandler.reset! if defined?(Herb::ActionView::SlimHandler)
    end

    test "renders with Herb::Engine and escapes through the output buffer" do
      html = render_herb_slim("p = name\np == name\n", { name: "<b>Ada</b>" })

      assert_equal "<p>&lt;b&gt;Ada&lt;/b&gt;</p><p><b>Ada</b></p>", html
    end

    test "html_safe values are not escaped again" do
      html = render_herb_slim("p = name\np title=name x\n", { name: "<b>Ada</b>".html_safe })

      assert_equal %(<p><b>Ada</b></p><p title="<b>Ada</b>">x</p>), html
    end

    test "block helpers capture like they do with the slim gem" do
      source = <<~SLIM
        = content_tag :section do
          p Inside
        = link_to "/x" do
          span Hi
      SLIM

      assert_equal render_slim(source), render_herb_slim(source)
    end

    test "strict locals work the way they do in ERB" do
      source = <<~SLIM
        /# locals: (name: "Default")
        p = name
      SLIM

      assert_equal "<p>Default</p>", render_herb_slim(source)
      assert_equal "<p>Ada</p>", render_herb_slim(source, { name: "Ada" })
    end

    test "debug markers are off by default" do
      html = render_herb_slim("p = name\n", { name: "Ada" }, identifier: "/app/views/show.html.slim")

      assert_equal "<p>Ada</p>", html
    end

    test "debug adds markers to templates in the project" do
      Herb::ActionView::SlimHandler.debug = true
      Herb::ActionView::SlimHandler.project_path = "/app"

      html = render_herb_slim(".card = name\n", { name: "Ada" }, identifier: "/app/views/posts/show.html.slim")
      card = Nokogiri::HTML5.fragment(html).at_css(".card")

      assert_equal "views/posts/show.html.slim", card["data-herb-debug-file-relative-path"]
      assert_equal "/app/views/posts/show.html.slim", card["data-herb-debug-file-full-path"]

      outside = render_herb_slim(".card = name\n", { name: "Ada" }, identifier: "/gems/engine/app/views/show.html.slim")

      assert_equal %(<div class="card">Ada</div>), outside
    end

    test "visitors run on every template the handler compiles" do
      Herb::ActionView::SlimHandler.visitors = [ShoutVisitor.new]

      assert_equal "<p>HELLO</p>", render_herb_slim("p hello\n")
    end

    test "visitors can be chosen per template" do
      Herb::ActionView::SlimHandler.visitors = ->(template) { template.identifier.include?("loud") ? [ShoutVisitor.new] : [] }

      assert_equal "<p>HELLO</p>", render_herb_slim("p hello\n", identifier: "loud.html.slim")
      assert_equal "<p>hello</p>", render_herb_slim("p hello\n", identifier: "quiet.html.slim")
    end

    test "only: leaves the other templates to the fallback handler" do
      Herb::ActionView::SlimHandler.visitors = [ShoutVisitor.new]

      handler = Herb::ActionView::SlimHandler.new(
        only: ->(template) { template.identifier.start_with?("/app/views/admin/") },
        fallback: SlimTestSupport.slim_handler
      )

      assert_equal "<p>HI</p>", render_herb_slim("p Hi\n", identifier: "/app/views/admin/show.html.slim", handler: handler)
      assert_equal "<p>Hi</p>", render_herb_slim("p Hi\n", identifier: "/app/views/show.html.slim", handler: handler)
    end

    test "only: needs a fallback" do
      assert_raises(ArgumentError) { Herb::ActionView::SlimHandler.new(only: ->(_) { true }) }
    end

    test "annotates templates with their file names when Action View does" do
      ActionView::Base.annotate_rendered_view_with_filenames = true

      html = render_herb_slim("p Hi\n", identifier: "#{Dir.pwd}/app/views/show.html.slim")

      assert_match(/\A<!-- BEGIN .*show\.html\.slim -->/, html)
      assert_match(/<!-- END .*show\.html\.slim -->\z/, html)
    ensure
      ActionView::Base.annotate_rendered_view_with_filenames = false
    end

    test "uses a configured engine class" do
      engine_class = Class.new(Herb::ActionView::OutputBufferEngine)
      Herb::ActionView::SlimHandler.engine_class = engine_class

      assert_equal engine_class, Herb::ActionView::SlimHandler.engine_class
      assert_equal "<p>Hi</p>", render_herb_slim("p Hi\n")
    end
  end
end
