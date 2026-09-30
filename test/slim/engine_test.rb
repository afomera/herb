# frozen_string_literal: true

require "tmpdir"

require_relative "slim_test_helper"
require_relative "../snapshot_utils"
require_relative "../../lib/herb/engine"
require_relative "../../lib/herb/engine/visitors/debug_visitor"
require_relative "../../lib/herb/engine/visitors/instrumentation_visitor"
require_relative "../../lib/herb/engine/validators"
require_relative "render_test"
require_relative "action_view_test"

module Slim
  # `Herb::Engine` compiling Slim: it parses with `exact_semantics`, compiles the tree like any other,
  # and keeps every line of Ruby on the Slim line it came from.
  class EngineTest < Minitest::Spec
    include SnapshotUtils
    include SlimTestSupport::TestHelper

    TEMPLATE = <<~'SLIM'
      doctype html
      / A comment
        spanning lines
      #main.box class=klass
        p Hello #{name}
        ul
          - items.each do |item|
            li = item
        - if items.size > 1
          span.big data-count=items.size == items.first
        p = boom
    SLIM

    def compile(source, **)
      Herb::Engine.new(source, language: "slim", escape: true, **)
    end

    # Every piece of Ruby read from the template, found on the line of the compiled source that has
    # the same number as the Slim line it was written on.
    def assert_code_on_its_slim_line(source, compiled)
      compiled_lines = compiled.lines

      written_code(source).each do |line, code|
        assert compiled_lines[line - 1].to_s.include?(code), "Expected `#{code}` on compiled line #{line}:\n#{compiled}"
      end
    end

    # [line, first line of code] for every ERB tag the Slim source wrote, leaving out the zero-width
    # ones the Slim frontend generated.
    def written_code(source)
      tree = Herb.parse(source, language: "slim", exact_semantics: true).value

      erb_content_nodes(tree).filter_map do |node|
        location = node.content.location

        [location.start.line, first_line(node.content.value)] if written?(location)
      end
    end

    def written?(location)
      location.start.line.positive? && location.start != location.end
    end

    def first_line(code)
      code.strip.lines.first.to_s.strip
    end

    test "compiles Slim with the language option" do
      assert_compiled_snapshot(TEMPLATE, language: "slim", escape: true)
    end

    test "picks Slim from a .slim filename" do
      engine = Herb::Engine.new("p = name\n", filename: "app/views/users/show.html.slim", escape: true)

      assert_equal "slim", engine.language
      assert_equal compile("p = name\n").src, engine.src
    end

    test "keeps ERB for other filenames" do
      assert_equal "erb", Herb::Engine.new("p = name\n", filename: "app/views/users/show.html.erb").language
      assert_equal "erb", Herb::Engine.new("p = name\n").language
    end

    test "picks Slim from the language parser option" do
      assert_equal "slim", Herb::Engine.new("p = name\n", parser_options: { language: "slim" }).language
    end

    test "rejects languages it doesn't compile" do
      error = assert_raises(ArgumentError) { Herb::Engine.new("x", language: "haml") }

      assert_equal %(Herb::Engine compiles erb and slim templates, not "haml"), error.message
    end

    test "parses with exact semantics even when asked not to" do
      source = "a href=url Link\n"

      assert_equal compile(source).src, compile(source, parser_options: { exact_semantics: false }).src
    end

    test "every line of Ruby lands on its Slim line" do
      engine = compile(TEMPLATE)

      assert_code_on_its_slim_line(TEMPLATE, engine.src)
      assert_equal TEMPLATE.lines.count + 1, engine.src.lines.count
    end

    test "the splat helpers stay on the first line" do
      source = <<~SLIM
        .card*attrs
          p = title
      SLIM

      engine = compile(source)

      assert_code_on_its_slim_line(source, engine.src)
      assert_match(/_slim_splat = lambda/, engine.src.lines.first)
    end

    test "a Ruby error is reported on its Slim line" do
      engine = compile(TEMPLATE.sub("p = boom", "p = boom.fetch(1)"))
      scope = binding_with(klass: "k", name: "Ada", items: [1, 2], boom: nil)

      error = assert_raises(NoMethodError) { scope.eval(engine.src, "boom.html.slim", 1) }
      location = error.backtrace_locations.find { |entry| entry.path == "boom.html.slim" }

      assert_equal 11, location.lineno
    end

    test "escapes = and leaves == alone, in attributes and scripts too" do
      source = <<~'SLIM'
        p title=value data-raw==value = value
        p == value
        javascript:
          var x = "#{value}";
      SLIM

      result = binding_with(value: %(<b>"'</b>)).eval(compile(source).src)

      assert_equal <<~HTML.delete("\n"), result
        <p title="&lt;b&gt;&quot;&#39;&lt;/b&gt;" data-raw="<b>"'</b>">&lt;b&gt;&quot;&#39;&lt;/b&gt;</p>
        <p><b>"'</b></p>
        <script>var x = "&lt;b&gt;&quot;&#39;&lt;/b&gt;";</script>
      HTML
    end

    test "uses the project's Slim settings, and parser options override them" do
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, ".herb.yml"), <<~YAML)
          slim:
            shortcuts:
              "~":
                attr: data-testid
              ".":
                attr: class
        YAML

        Herb.configure(dir)

        assert_equal %(<p data-testid="intro">Hi</p>), eval_slim("p~intro Hi\n")
        assert_equal %(<p role="intro">Hi</p>), eval_slim("p@intro Hi\n", parser_options: { slim_shortcuts: { "@" => "role" } })
      ensure
        Herb.reset_configuration!
      end
    end

    test "Slim templates pass the validators" do
      source = <<~SLIM
        .card*attrs class=klass
          a href=url = title
      SLIM

      compile(source, visitors: Herb::Engine::Validators.all, validate_ruby: true)
    end

    test "Herb::Engine renders the corpus like the slim gem" do
      skip SlimTestSupport.render_dependency_error if SlimTestSupport.render_dependency_error

      [[RenderTest::CORPUS, RenderTest::LOCALS], [ActionViewTest::CORPUS, ActionViewTest::LOCALS]].each do |corpus, locals|
        corpus.each do |description, source|
          expected = render_slim(source, locals)
          actual = render_herb_slim(source, locals)

          assert_equal normalize_html(expected), normalize_html(actual), <<~MESSAGE
            #{description} rendered differently with Herb::Engine.

            Slim:
            #{source}
            Slim gem:
            #{expected}
            Herb::Engine:
            #{actual}
          MESSAGE
        end
      end
    end

    test "an Action View error points at the Slim line" do
      skip SlimTestSupport.render_dependency_error if SlimTestSupport.render_dependency_error

      source = TEMPLATE.sub("p = boom", "p = boom.fetch(1)")
      locals = { klass: "k", name: "Ada", items: [1, 2], boom: nil }

      error = assert_raises(ActionView::Template::Error) { render_herb_slim(source, locals) }

      assert_equal "11", error.line_number
    end

    private

    def eval_slim(source, **)
      binding_with.eval(compile(source, **).src)
    end

    def binding_with(**locals)
      scope = Object.new.instance_eval { binding }
      locals.each { |name, value| scope.local_variable_set(name, value) }
      scope
    end
  end
end
