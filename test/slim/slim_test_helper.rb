# frozen_string_literal: true

require_relative "../test_helper"

module SlimTestSupport
  # The render oracle needs the slim gem (and ActionView + Nokogiri to render and compare). They are optional:
  # when one can't be loaded, the rendering tests skip and the parser/snapshot tests still run.
  def self.render_dependency_error
    return @render_dependency_error if defined?(@render_dependency_error)

    @render_dependency_error = begin
      require "action_view"
      require "nokogiri"
      require "slim"
      nil
    rescue LoadError => e
      "#{e.message} (install the slim, actionview and nokogiri gems to run the Slim render tests)"
    end
  end

  # `options` are extra Slim engine options (e.g. `shortcut:` and `merge_attrs:`).
  def self.slim_handler(**options)
    raise LoadError, render_dependency_error if render_dependency_error

    @slim_handlers ||= {}
    @slim_handlers[options] ||= Temple::Templates::Rails(
      Slim::Engine,
      generator: Temple::Generators::RailsOutputBuffer,
      disable_capture: true,
      format: :html,
      js_wrapper: nil,
      **options
    ).new
  end

  # Prints a Herb syntax tree as HTML+ERB by concatenating token values and node contents, the same way
  # the JavaScript IdentityPrinter does. Used to check that a tree parsed from Slim is equivalent HTML+ERB.
  class ERBTestPrinter # rubocop:disable Metrics/ClassLength
    # rubocop:disable Naming/MethodName
    def self.print(node)
      new.tap { |printer| printer.visit(node) }.output
    end

    attr_reader :output

    def initialize
      @output = +""
    end

    def visit(node)
      return if node.nil?

      method = :"print_#{node.class.name.split("::").last}"

      raise ArgumentError, "Don't know how to print #{node.class}" unless respond_to?(method, true)

      send(method, node)
    end

    private

    def write(value)
      @output << value.to_s if value
    end

    def token(token)
      write(token&.value)
    end

    def visit_all(nodes)
      Array(nodes).each { |node| visit(node) }
    end

    def erb_tag(node)
      token(node.tag_opening)
      token(node.content)
      token(node.tag_closing)
    end

    def print_DocumentNode(node) = visit_all(node.children)
    def print_LiteralNode(node) = write(node.content)
    def print_HTMLTextNode(node) = write(node.content)
    def print_RubyLiteralNode(node) = write("<%= #{node.content} %>")
    def print_WhitespaceNode(node) = token(node.value)
    def print_HTMLVirtualCloseTagNode(_node) = nil
    def print_HTMLOmittedCloseTagNode(_node) = nil

    def print_HTMLOpenTagNode(node)
      token(node.tag_opening)
      token(node.tag_name)

      node.children.each do |child|
        write(" ") if child.is_a?(Herb::AST::HTMLAttributeNode) && !@output.end_with?(" ")
        visit(child)
      end

      token(node.tag_closing)
    end

    def print_HTMLCloseTagNode(node)
      token(node.tag_opening)
      token(node.tag_name)
      token(node.tag_closing)
    end

    def print_HTMLElementNode(node)
      return print_action_view_element(node) if node.open_tag.is_a?(Herb::AST::ERBOpenTagNode)

      visit(node.open_tag)
      visit_all(node.body)
      visit(node.close_tag)
    end

    # Elements transformed from ActionView helpers (`action_view_helpers: true`) keep the helper call in an
    # ERBOpenTagNode. Print them as the HTML the helper renders, with Ruby attribute values as ERB output.
    def print_action_view_element(node) # rubocop:disable Metrics/AbcSize
      write("<#{node.tag_name.value}")

      node.open_tag.children.each do |attribute|
        next unless attribute.is_a?(Herb::AST::HTMLAttributeNode)

        write(" ")
        visit(attribute.name)
        next unless attribute.value

        write('="')

        attribute.value.children.each do |child|
          if child.is_a?(Herb::AST::RubyLiteralNode)
            write("<%= #{child.content} %>")
          else
            visit(child)
          end
        end

        write('"')
      end

      write(">")
      visit_all(node.body)
      write("</#{node.tag_name.value}>") unless node.is_void
    end

    def print_HTMLAttributeNode(node)
      visit(node.name)
      token(node.equals) if node.value
      visit(node.value)
    end

    def print_HTMLAttributeNameNode(node) = visit_all(node.children)

    def print_HTMLAttributeValueNode(node)
      write(node.open_quote ? node.open_quote.value : ('"' if node.quoted))
      visit_all(node.children)
      write(node.close_quote ? node.close_quote.value : ('"' if node.quoted))
    end

    def print_RubyHTMLAttributesSplatNode(node)
      write("<%= #{node.content} %>")
    end

    def print_HTMLCommentNode(node)
      token(node.comment_start)
      visit_all(node.children)
      token(node.comment_end)
    end

    def print_HTMLDoctypeNode(node)
      token(node.tag_opening)
      visit_all(node.children)
      token(node.tag_closing)
    end

    alias print_XMLDeclarationNode print_HTMLDoctypeNode
    alias print_CDATANode print_HTMLDoctypeNode

    def print_ERBContentNode(node) = erb_tag(node)
    def print_ERBCommentNode(node) = erb_tag(node)
    def print_ERBEndNode(node) = erb_tag(node)
    def print_ERBYieldNode(node) = erb_tag(node)
    def print_ERBRenderNode(node) = print_ERBBlockNode(node)

    def print_ERBOpenTagNode(node)
      erb_tag(node)
      visit_all(node.children)
    end

    def print_ERBIfNode(node)
      erb_tag(node)
      visit_all(node.statements)
      visit(node.subsequent)
      visit(node.end_node)
    end

    def print_ERBUnlessNode(node)
      erb_tag(node)
      visit_all(node.statements)
      visit(node.else_clause)
      visit(node.end_node)
    end

    def print_ERBElseNode(node)
      erb_tag(node)
      visit_all(node.statements)
    end

    alias print_ERBWhenNode print_ERBElseNode
    alias print_ERBInNode print_ERBElseNode
    alias print_ERBEnsureNode print_ERBElseNode

    def print_ERBRescueNode(node)
      erb_tag(node)
      visit_all(node.statements)
      visit(node.subsequent)
    end

    def print_ERBBlockNode(node)
      erb_tag(node)
      visit_all(node.body)
      visit(node.rescue_clause)
      visit(node.else_clause)
      visit(node.ensure_clause)
      visit(node.end_node)
    end

    alias print_ERBIterationBlockNode print_ERBBlockNode

    def print_ERBBeginNode(node)
      erb_tag(node)
      visit_all(node.statements)
      visit(node.rescue_clause)
      visit(node.else_clause)
      visit(node.ensure_clause)
      visit(node.end_node)
    end

    def print_ERBCaseNode(node)
      erb_tag(node)
      visit_all(node.children)
      visit_all(node.conditions)
      visit(node.else_clause)
      visit(node.end_node)
    end

    alias print_ERBCaseMatchNode print_ERBCaseNode

    def print_ERBWhileNode(node)
      erb_tag(node)
      visit_all(node.statements)
      visit(node.end_node)
    end

    alias print_ERBUntilNode print_ERBWhileNode
    alias print_ERBForNode print_ERBWhileNode

    # rubocop:enable Naming/MethodName
  end

  module TestHelper
    def parse_slim(source, **)
      Herb.parse(source, language: "slim", **)
    end

    def slim_to_erb(source, **)
      result = parse_slim(source, **)

      assert_empty result.errors.map(&:message), "Expected Slim source to parse without errors:\n#{source}"

      erb = SlimTestSupport::ERBTestPrinter.print(result.value)

      assert_empty Herb.parse(erb).errors.map(&:message), "Expected the printed ERB to parse without errors:\n#{erb}"

      erb
    end

    def render_slim(source, locals = {}, slim_options: {})
      view = build_view
      handler = SlimTestSupport.slim_handler(**slim_options)
      template = ActionView::Template.new(source, "(slim)", handler, locals: locals.keys, format: :html)

      template.render(view, locals).to_s
    end

    def render_erb(source, locals = {})
      view = build_view
      handler = ActionView::Template::Handlers::ERB.new
      template = ActionView::Template.new(source, "(erb)", handler, locals: locals.keys, format: :html)

      template.render(view, locals).to_s
    end

    def normalize_html(html) # rubocop:disable Metrics/AbcSize
      fragment = Nokogiri::HTML5.fragment(html.to_s)

      fragment.traverse do |node|
        next unless node.element?

        attributes = node.attribute_nodes.sort_by(&:name).map { |attribute| [attribute.name, attribute.value] }
        node.attribute_nodes.each { |attribute| node.remove_attribute(attribute.name) }
        attributes.each { |name, value| node[name] = value }
      end

      fragment.to_html
    end

    # Renders the Slim source with the slim gem and the HTML+ERB printed from Herb's tree with ActionView,
    # and asserts both produce the same HTML (attribute order and entity encoding are normalized). The tree is
    # parsed with `exact_semantics: true`, which lowers Slim's runtime semantics into the printed ERB.
    # `slim_options` are passed to the slim gem, the other options to `Herb.parse`.
    def assert_slim_renders_like_erb(source, locals = {}, slim_options: {}, **)
      skip SlimTestSupport.render_dependency_error if SlimTestSupport.render_dependency_error

      erb = slim_to_erb(source, exact_semantics: true, **)
      expected = render_slim(source, locals, slim_options: slim_options)
      actual = render_erb(erb, locals)

      assert_equal normalize_html(expected), normalize_html(actual), <<~MESSAGE
        Slim and the printed ERB rendered differently.

        Slim:
        #{source}
        Printed ERB:
        #{erb}
        Slim output:
        #{expected}
        ERB output:
        #{actual}
      MESSAGE

      erb
    end

    private

    def build_view
      ActionView::Base.with_empty_template_cache.new(ActionView::LookupContext.new([]), {}, nil)
    end
  end
end
