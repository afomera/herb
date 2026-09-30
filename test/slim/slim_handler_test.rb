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

    # The template objects ViewComponent passes to a handler: 4.x and 3.x pass the source as the second
    # argument, next to a struct without `source`. 3.x passes `DataNoSource` to one-argument handlers.
    ComponentTemplate = Struct.new(:format, :identifier, :short_identifier, :type)
    KeywordComponentTemplate = Struct.new(:format, :identifier, :short_identifier, :type, keyword_init: true)
    ComponentTemplateWithSource = Struct.new(:source, :identifier, :type, keyword_init: true)

    FallbackHandler = Struct.new(:calls) do
      def call(template, source)
        calls << [template, source]

        "@output_buffer.safe_append='fallback'.freeze;@output_buffer"
      end
    end

    class Logger
      attr_reader :messages

      def initialize
        @messages = []
      end

      def info(message)
        @messages << message
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

    test "compiles ViewComponent's template struct, which has no source" do
      template = ComponentTemplate.new(:html, "/app/components/card_component.html.slim", "app/components/card_component.html.slim", ActionView::Template::Types[:html])
      source = ".card = @title\n"

      assert_equal %(<div class="card">&lt;b&gt;Hi&lt;/b&gt;</div>), render_component(Herb::ActionView::SlimHandler, template, source, title: "<b>Hi</b>")
      assert_equal render_slim(".card = title\n", { title: "<b>Hi</b>" }), render_component(Herb::ActionView::SlimHandler, template, source, title: "<b>Hi</b>")
    end

    test "compiles ViewComponent 3's keyword struct and inline templates" do
      template = KeywordComponentTemplate.new(format: :html, identifier: "/app/components/inline_component.rb", short_identifier: "app/components/inline_component.rb", type: ActionView::Template::Types[:html])

      assert_equal "<p>Hi</p>", render_component(Herb::ActionView::SlimHandler, template, "p = @title\n", title: "Hi")
    end

    test "reads the source from a template-like object when none is passed" do
      template = ComponentTemplateWithSource.new(source: "p = @title\n", identifier: "/app/components/card_component.html.slim", type: nil)

      assert_equal "<p>Hi</p>", render_component(Herb::ActionView::SlimHandler, template, nil, title: "Hi")
    end

    test "a template without a source needs one passed" do
      template = ComponentTemplate.new(:html, "/app/components/card_component.html.slim", nil, nil)

      error = assert_raises(ArgumentError) { Herb::ActionView::SlimHandler.call(template) }

      assert_match(/card_component\.html\.slim has no source/, error.message)
    end

    test "works with a template that has only an identifier, and with debug on" do
      Herb::ActionView::SlimHandler.debug = true
      Herb::ActionView::SlimHandler.project_path = "/app"
      ActionView::Base.annotate_rendered_view_with_filenames = true

      template = Struct.new(:identifier).new("/app/components/card_component.html.slim")
      html = render_component(Herb::ActionView::SlimHandler, template, ".card Hi\n")

      assert_equal "components/card_component.html.slim", Nokogiri::HTML5.fragment(html).at_css(".card")["data-herb-debug-file-relative-path"]

      bare = render_component(Herb::ActionView::SlimHandler, Object.new, ".card Hi\n")

      assert_equal %(<div class="card">Hi</div>), bare
    ensure
      ActionView::Base.annotate_rendered_view_with_filenames = false
    end

    test "debug markers on a component's template" do
      Herb::ActionView::SlimHandler.debug = true
      Herb::ActionView::SlimHandler.project_path = "/app"

      template = ComponentTemplate.new(:html, "/app/components/card_component.html.slim", "app/components/card_component.html.slim", ActionView::Template::Types[:html])
      card = Nokogiri::HTML5.fragment(render_component(Herb::ActionView::SlimHandler, template, ".card Hi\n")).at_css(".card")

      assert_equal "/app/components/card_component.html.slim", card["data-herb-debug-file-full-path"]
    end

    test "only: and the fallback get ViewComponent's struct and the source" do
      fallback = FallbackHandler.new([])
      handler = Herb::ActionView::SlimHandler.new(only: ->(template) { template.identifier.include?("/admin/") }, fallback: fallback)

      admin = ComponentTemplate.new(:html, "/app/components/admin/card_component.html.slim", nil, nil)
      other = ComponentTemplate.new(:html, "/app/components/card_component.html.slim", nil, nil)

      assert_equal "<p>Hi</p>", render_component(handler, admin, "p Hi\n")
      assert_equal "fallback", render_component(handler, other, "p Hi\n")
      assert_equal [[other, "p Hi\n"]], fallback.calls
    end

    test "only: gets the source when it takes two arguments" do
      seen = []
      handler = Herb::ActionView::SlimHandler.new(
        only: lambda { |template, source|
          seen << [template.identifier, source]
          !source.include?("legacy")
        },
        fallback: FallbackHandler.new([])
      )

      template = ComponentTemplate.new(:html, "/app/components/card_component.html.slim", nil, nil)

      assert_equal "<p>Hi</p>", render_component(handler, template, "p Hi\n")
      assert_equal "fallback", render_component(handler, template, "p legacy\n")
      assert_equal [["/app/components/card_component.html.slim", "p Hi\n"], ["/app/components/card_component.html.slim", "p legacy\n"]], seen
    end

    test "only: can be any callable" do
      picker = Object.new
      def picker.call(template, source = nil) = source.to_s.include?("herb") && template.identifier.end_with?(".slim")

      handler = Herb::ActionView::SlimHandler.new(only: picker, fallback: FallbackHandler.new([]))

      assert_equal "<p>herb</p>", render_herb_slim("p herb\n", identifier: "/app/views/show.html.slim", handler: handler)
      assert_equal "fallback", render_herb_slim("p slim\n", identifier: "/app/views/show.html.slim", handler: handler)
    end

    test "fallback_on_errors: compiles what Herb can't parse with the fallback, and logs it once" do
      logger = Logger.new
      fallback = FallbackHandler.new([])
      Herb::ActionView::SlimHandler.logger = logger
      handler = Herb::ActionView::SlimHandler.new(fallback: fallback, fallback_on_errors: true)
      source = "markdown:\n  # Hi\n"

      assert_equal "<p>Hi</p>", render_herb_slim("p Hi\n", identifier: "/app/views/show.html.slim", handler: handler)
      assert_equal "fallback", render_herb_slim(source, identifier: "/app/views/notes.html.slim", handler: handler)
      assert_equal "fallback", render_herb_slim(source, identifier: "/app/views/notes.html.slim", handler: handler)

      template = ComponentTemplate.new(:html, "/app/components/notes_component.rb", "app/components/notes_component.rb", nil)

      assert_equal "fallback", render_component(handler, template, source)

      assert_equal 3, fallback.calls.length
      assert_equal 2, logger.messages.length
      assert_match(%r{\A\[Herb\] /app/views/notes\.html\.slim is rendered by .*FallbackHandler, since Herb could not compile it: line 1:1: Unsupported embedded engine}, logger.messages.first)
      assert_match(%r{app/components/notes_component\.rb is rendered by}, logger.messages.last)
    end

    test "without fallback_on_errors: a parse error raises" do
      handler = Herb::ActionView::SlimHandler.new(only: ->(_) { true }, fallback: FallbackHandler.new([]))

      assert_raises(Herb::Engine::ParseError) { handler.call(ComponentTemplate.new(:html, "/app/x.html.slim", nil, nil), "markdown:\n  # Hi\n") }
    end

    test "fallback_on_errors: needs a fallback" do
      assert_raises(ArgumentError) { Herb::ActionView::SlimHandler.new(fallback_on_errors: true) }
    end

    test "uses a configured engine class" do
      engine_class = Class.new(Herb::ActionView::OutputBufferEngine)
      Herb::ActionView::SlimHandler.engine_class = engine_class

      assert_equal engine_class, Herb::ActionView::SlimHandler.engine_class
      assert_equal "<p>Hi</p>", render_herb_slim("p Hi\n")
    end

    private

    # Compiles like ViewComponent does, into a method on the component (here a view), and calls it.
    def render_component(handler, template, source, assigns = {})
      view = build_view
      assigns.each { |name, value| view.instance_variable_set(:"@#{name}", value) }

      src = source.nil? ? handler.call(template) : handler.call(template, source)
      view.singleton_class.class_eval("def __render_component\n#{src}\nend", __FILE__, __LINE__)
      view.instance_variable_set(:@output_buffer, ActionView::OutputBuffer.new)

      view.__render_component.to_s
    end
  end
end
