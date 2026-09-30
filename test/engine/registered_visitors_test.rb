# frozen_string_literal: true

require_relative "../test_helper"
require_relative "../../lib/herb/engine"
require_relative "../../lib/herb/engine/visitors/debug_visitor"
require_relative "../../lib/herb/engine/visitors/instrumentation_visitor"

begin
  require "slim"
rescue LoadError
  # the Slim comparison skips
end

# The Slim version of the test-id example, the filter an app registers with
# `Slim::Engine.after Slim::Controls, SlimTestIdFilter`.
if defined?(Temple::HTML::Filter)
  class SlimTestIdFilter < Temple::HTML::Filter
    def on_html_attr(name, value) = (name == "data-testid" ? nil : super)
    def on_html_attrs(*attrs) = [:html, :attrs, *attrs.map { |attribute| compile(attribute) }.compact]
  end
end

module Engine
  class RegisteredVisitorsTest < Minitest::Spec
    # The example from the docs: drops every `data-testid` attribute, the Herb version of a Temple
    # filter registered with `Slim::Engine.after Slim::Controls, SlimTestIdFilter`. It looks inside the
    # control flow an open tag holds, which is where a Slim attribute with a Ruby value lives once
    # `exact_semantics` has lowered it.
    class StripTestIds < Herb::Visitor
      BRANCHES = [:statements, :subsequent, :else_clause].freeze

      def visit_html_open_tag_node(node)
        strip(node.children)
        super
      end

      private

      def strip(nodes)
        doomed(nodes).reverse_each { |index| nodes.delete_at(index) }

        nodes.each { |child| branches(child).each { |branch| strip(branch) } }
      end

      # The test id attributes, and the whitespace written before each of them.
      def doomed(nodes)
        attributes = nodes.each_index.select { |index| test_id?(nodes[index]) }
        spaces = attributes.map { |index| index - 1 }.select { |index| index >= 0 && nodes[index].is_a?(Herb::AST::WhitespaceNode) }

        (attributes | spaces).sort
      end

      def branches(node)
        BRANCHES.filter_map do |branch|
          next unless node.respond_to?(branch)

          value = node.public_send(branch)
          value.is_a?(Array) ? value : value && [value]
        end
      end

      def test_id?(node)
        node.is_a?(Herb::AST::HTMLAttributeNode) &&
          node.name.children.all?(Herb::AST::LiteralNode) &&
          node.name.children.map(&:content).join == "data-testid"
      end
    end

    class CountingVisitor < Herb::Visitor
      attr_reader :elements

      def initialize
        super
        @elements = 0
      end

      def visit_html_element_node(node)
        @elements += 1
        super
      end
    end

    class ReadingVisitor < Herb::Visitor
      def self.reads_erb_source? = true
    end

    after do
      Herb::Engine.reset_registered_visitors!
    end

    def render(source, options = {}, **locals)
      scope = Object.new.instance_eval { binding }
      locals.each { |name, value| scope.local_variable_set(name, value) }

      scope.eval(Herb::Engine.new(source, escape: true, **options).src)
    end

    test "a registered visitor class runs on every compile, built fresh each time" do
      Herb::Engine.register_visitor(StripTestIds)

      assert_equal %(<div id="a"></div>), render(%(<div data-testid="x" id="a"></div>))
      assert_equal %(<p></p>), render(%(<p data-testid="<%= name %>"></p>), name: "y")
    end

    test "strips test ids from Slim, the way the Temple filter does in the slim gem" do
      skip "needs the slim gem" unless slim_available?

      Herb::Engine.register_visitor(StripTestIds)

      source = <<~SLIM
        div data-testid="static" id="a"
          span data-testid=name Hi
          p(data-testid="x" class="c") = name
        - if name
          a data-testid="#{name}" href="/"
      SLIM

      expected = slim_with_test_id_filter(source, name: "Ada")
      actual = render(source, { language: "slim" }, name: "Ada")

      assert_equal expected, actual
    end

    test "a block builds the visitor per template, and nil skips it" do
      seen = []

      Herb::Engine.register_visitor do |context|
        seen << context.language
        StripTestIds.new if context.language == "slim"
      end

      assert_equal %(<p data-testid="x"></p>), render(%(<p data-testid="x"></p>))
      assert_equal %(<p></p>), render(%(p data-testid="x"\n), { language: "slim" })
      assert_equal ["erb", "slim"], seen
    end

    test "an instance is shared by every compile" do
      counter = CountingVisitor.new
      Herb::Engine.register_visitor(counter)

      render("<div><p></p></div>")
      render("<br>")

      assert_equal 3, counter.elements
    end

    test "unregistering a visitor stops it" do
      registration = Herb::Engine.register_visitor(StripTestIds)

      assert Herb::Engine.unregister_visitor(registration)
      refute Herb::Engine.unregister_visitor(registration)
      assert_equal %(<p data-testid="x"></p>), render(%(<p data-testid="x"></p>))
    end

    test "registered_visitors: false compiles without them" do
      Herb::Engine.register_visitor(StripTestIds)

      assert_equal %(<p data-testid="x"></p>), render(%(<p data-testid="x"></p>), { registered_visitors: false })
    end

    test "registrations made on a subclass apply to Herb::Engine too" do
      subclass = Class.new(Herb::Engine)
      subclass.register_visitor(StripTestIds)

      assert_equal 1, Herb::Engine.registered_visitors.size
      assert_equal %(<p></p>), render(%(<p data-testid="x"></p>))
    end

    test "registered visitors run after the given ones, or where before: and after: say" do
      Herb::Engine.register_visitor(StripTestIds)
      Herb::Engine.register_visitor(CountingVisitor, before: Herb::Engine::DebugVisitor)

      engine = Herb::Engine.new("<p></p>", visitors: [Herb::Engine::DebugVisitor.new])

      assert_equal [CountingVisitor, Herb::Engine::DebugVisitor, StripTestIds], engine.visitors.map(&:class)
    end

    test "an anchor that isn't in the stack appends" do
      Herb::Engine.register_visitor(CountingVisitor, after: Herb::Engine::DebugVisitor)

      assert_equal [CountingVisitor], Herb::Engine.new("<p></p>").visitors.map(&:class)
    end

    test "declared ordering still holds" do
      Herb::Engine.register_visitor(ReadingVisitor)

      engine = Herb::Engine.new("<p><%= x %></p>", visitors: [Herb::Engine::InstrumentationVisitor.new])

      assert_equal [ReadingVisitor, Herb::Engine::InstrumentationVisitor], engine.visitors.map(&:class)
    end

    test "register_visitor needs one visitor" do
      assert_raises(ArgumentError) { Herb::Engine.register_visitor }
      assert_raises(ArgumentError) { Herb::Engine.register_visitor(StripTestIds) { StripTestIds.new } }
      assert_raises(ArgumentError) { Herb::Engine.register_visitor(StripTestIds, before: StripTestIds, after: StripTestIds) }
    end

    private

    def slim_available?
      defined?(SlimTestIdFilter)
    end

    def slim_with_test_id_filter(source, **locals)
      engine = Class.new(Slim::Engine) { after Slim::Controls, SlimTestIdFilter }

      Temple::Templates::Tilt(engine, format: :html).new { source }.render(Object.new, locals)
    end
  end
end
