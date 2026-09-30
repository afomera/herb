# frozen_string_literal: true

require_relative "../test_helper"
require_relative "../../lib/herb/dev"

module Dev
  class PipelineTest < Minitest::Spec
    class FakeServer
      attr_reader :messages #: Array[Array[untyped]]

      def initialize
        @messages = []
      end

      def broadcast(message, to: :all)
        @messages << [message, to]
      end
    end

    Compiled = Struct.new(:mode, :manifest, :version, :slot_entries, :statics, :static_markup, :diagnostics)

    def event(kind, relative_path, previous, current)
      Herb::Dev::Watcher::Event.new(
        kind: kind,
        path: "/app/#{relative_path}",
        relative_path: relative_path,
        previous: previous,
        current: current
      )
    end

    def compiled(version: "abcd1234", mode: :client, diagnostics: [], slot_entries: [], states: nil, statics: nil) # rubocop:disable Metrics/ParameterLists
      Compiled.new(mode, { "names" => {}, "states" => states }, version, slot_entries, statics, nil, diagnostics)
    end

    def pipeline(server, compiler: nil)
      Herb::Dev::Pipeline.new(server: server, compiler: -> { compiler })
    end

    test "the first compile leaves changed statics unknown, the second names the changed keys" do
      server = FakeServer.new
      results = [
        compiled(statics: { "9:item" => "<li>old</li>", "8:0" => "arm" }),
        compiled(statics: { "9:item" => "<li>new</li>", "8:0" => "arm" })
      ]
      subject = pipeline(server, compiler: ->(_source, _path) { results.shift })

      subject.handle_event(event(:changed, "a.html.erb", "<p>a</p>", "<p>b</p>"))
      subject.handle_event(event(:changed, "a.html.erb", "<p>b</p>", "<p>c</p>"))

      schemas = server.messages.map(&:first).select { |message| message[:type] == "schema" }

      assert_nil schemas[0][:changed_statics]
      assert_equal ["9:item"], schemas[1][:changed_statics]
    end

    test "a whitespace change broadcasts nothing" do
      server = FakeServer.new

      pipeline(server).handle_event(
        event(:changed, "a.html.erb", "<div>\n  <p>Hi</p>\n</div>\n", "<div>\n    <p>Hi</p>\n</div>\n")
      )

      assert_empty server.messages
    end

    test "a parse error broadcasts an error message" do
      server = FakeServer.new

      pipeline(server).handle_event(event(:changed, "a.html.erb", "<div></div>", "<div>\n  <form>\n</div>\n"))

      types = server.messages.map { |message, _| message[:type] }

      assert_equal ["error"], types
    end

    test "without a compiler a dynamic change is an invalidate telling browsers to fetch" do
      server = FakeServer.new

      pipeline(server).handle_event(event(:changed, "a.html.erb", "<p><%= a %></p>", "<p><%= b %></p>"))

      message, to = server.messages.first

      assert_equal "invalidate", message[:type]
      assert_equal "fetch", message[:scope]
      assert_nil message[:version]
      assert_equal :browsers, to
    end

    test "without a compiler a static change is scoped static" do
      server = FakeServer.new

      pipeline(server).handle_event(event(:changed, "a.html.erb", "<p>Hi</p>", "<p>Hello</p>"))

      message, = server.messages.first

      assert_equal "static", message[:scope]
    end

    test "with a compiler a change broadcasts schema then invalidate to browsers" do
      server = FakeServer.new

      pipeline(server, compiler: ->(_source, _path) { compiled }).handle_event(
        event(:changed, "a.html.erb", "<p>Hi</p>", "<p>Hello</p>")
      )

      types = server.messages.map { |message, _| message[:type] }
      targets = server.messages.map { |_, to| to }.uniq

      assert_equal ["schema", "invalidate"], types
      assert_equal [:browsers], targets
    end

    test "the schema always carries diagnostics, and an empty array marks the file clean" do
      server = FakeServer.new

      pipeline(server, compiler: ->(_source, _path) { compiled }).handle_event(
        event(:changed, "a.html.erb", "<p>Hi</p>", "<p>Hello</p>")
      )

      schema, = server.messages.first

      assert_equal [], schema[:diagnostics]
    end

    test "an unchanged version with a moved state manifest scopes to state" do
      server = FakeServer.new
      manifests = [{ "reads" => { "count" => [0] } }, { "reads" => { "count" => [1] } }].each
      compiler = ->(_source, _path) { compiled(version: "same", states: manifests.next) }
      subject = pipeline(server, compiler: compiler)

      subject.handle_event(event(:changed, "a.html.erb", "<p><%= a %></p>", "<p><%= b %></p>"))
      server.messages.clear
      subject.handle_event(event(:changed, "a.html.erb", "<p><%= b %></p>", "<p><%= c %></p>"))

      invalidate, = server.messages.last

      assert_equal "state", invalidate[:scope]
      assert_equal "same", invalidate[:version]
    end

    test "an unchanged version with an unmoved state manifest scopes to fetch" do
      server = FakeServer.new
      compiler = ->(_source, _path) { compiled(version: "same", states: { "reads" => {} }) }
      subject = pipeline(server, compiler: compiler)

      subject.handle_event(event(:changed, "a.html.erb", "<p><%= a %></p>", "<p><%= b %></p>"))
      server.messages.clear
      subject.handle_event(event(:changed, "a.html.erb", "<p><%= b %></p>", "<p><%= c %></p>"))

      invalidate, = server.messages.last

      assert_equal "fetch", invalidate[:scope]
    end

    test "a changed version scopes a dynamic change to fetch" do
      server = FakeServer.new
      versions = ["v1", "v2"].each
      compiler = ->(_source, _path) { compiled(version: versions.next) }
      subject = pipeline(server, compiler: compiler)

      subject.handle_event(event(:changed, "a.html.erb", "<p><%= a %></p>", "<p><%= b %></p>"))
      server.messages.clear
      subject.handle_event(event(:changed, "a.html.erb", "<p><%= b %></p>", "<p><%= c %></p>"))

      schema, = server.messages.first
      invalidate, = server.messages.last

      assert_equal({ from: "v1", to: "v2" }, schema[:version])
      assert_equal "fetch", invalidate[:scope]
    end

    test "compile diagnostics enter the error state and a clean compile clears them" do
      server = FakeServer.new
      results = [
        compiled(diagnostics: [{ message: "bad state read", severity: :error }]),
        compiled
      ].each
      subject = pipeline(server, compiler: ->(_source, _path) { results.next })

      subject.handle_event(event(:changed, "a.html.erb", "<p>Hi</p>", "<p>Hello</p>"))

      first_schema, = server.messages.first

      assert_equal 1, first_schema[:diagnostics].length

      server.messages.clear
      subject.handle_event(event(:changed, "a.html.erb", "<p>Hello</p>", "<p>Howdy</p>"))

      second_schema, = server.messages.first

      assert_equal [], second_schema[:diagnostics]
    end

    test "a compiler raise becomes a diagnostics-only schema, not a crash" do
      server = FakeServer.new

      pipeline(server, compiler: ->(_source, _path) { raise "boom" }).handle_event(
        event(:changed, "a.html.erb", "<p>Hi</p>", "<p>Hello</p>")
      )

      schema, = server.messages.first

      assert_equal "schema", schema[:type]
      assert_equal 1, schema[:diagnostics].length

      assert_equal "RuntimeError: boom", schema[:diagnostics].first[:message]
    end

    test "a compiler answering nil degrades to the no-compiler path" do
      server = FakeServer.new

      pipeline(server, compiler: ->(_source, _path) {}).handle_event(
        event(:changed, "a.html.erb", "<p><%= a %></p>", "<p><%= b %></p>")
      )

      message, = server.messages.first

      assert_equal "invalidate", message[:type]
      assert_equal "fetch", message[:scope]
    end

    test "removing an errored file broadcasts a clearing schema" do
      server = FakeServer.new
      subject = pipeline(server)

      subject.handle_event(event(:changed, "a.html.erb", "<div></div>", "<div>\n  <form>\n</div>\n"))
      server.messages.clear
      subject.handle_event(event(:removed, "a.html.erb", "<div>\n  <form>\n</div>\n", nil))

      schema, = server.messages.first

      assert_equal "schema", schema[:type]
      assert_equal [], schema[:diagnostics]
    end

    test "removing a clean file broadcasts nothing" do
      server = FakeServer.new

      pipeline(server).handle_event(event(:removed, "a.html.erb", "<p>Hi</p>", nil))

      assert_empty server.messages
    end

    test "recovering from a parse error without a compiler broadcasts a clearing schema" do
      server = FakeServer.new
      subject = pipeline(server)

      subject.handle_event(event(:changed, "a.html.erb", "<div></div>", "<div>\n  <form>\n</div>\n"))
      server.messages.clear
      subject.handle_event(event(:changed, "a.html.erb", "<div>\n  <form>\n</div>\n", "<div>\n  <form></form>\n</div>\n"))

      types = server.messages.map { |message, _| message[:type] }

      assert_equal ["schema", "invalidate"], types
      assert_equal [], server.messages.find { |message, _| message[:type] == "schema" }.first[:diagnostics]
    end

    test "a rebuilt stylesheet broadcasts an asset message to browsers" do
      server = FakeServer.new
      subject = pipeline(server)

      subject.handle_event(event(:stylesheet, "app/assets/builds/tailwind.css", nil, nil))

      message, to = server.messages.first

      assert_equal({ type: "asset", kind: "stylesheet", file: "app/assets/builds/tailwind.css" }, message)
      assert_equal :browsers, to
    end

    test "a rebuilt script broadcasts its own asset kind" do
      server = FakeServer.new
      subject = pipeline(server)

      subject.handle_event(event(:script, "app/assets/builds/application.js", nil, nil))

      assert_equal({ type: "asset", kind: "script", file: "app/assets/builds/application.js" }, server.messages.first.first)
    end

    test "a Slim change reaches the host compiler with its source and path" do
      server = FakeServer.new
      compiled_files = []

      compiler = lambda do |source, path|
        compiled_files << [source, path]
        compiled
      end

      pipeline(server, compiler: compiler).handle_event(
        event(:changed, "a.html.slim", "p Hi\n", "p Hello\n")
      )

      assert_equal [["p Hello\n", "a.html.slim"]], compiled_files
      assert_equal(["schema", "invalidate"], server.messages.map { |message, _| message[:type] })
    end

    test "a Slim text edit is a static invalidate the browsers patch in place" do
      server = FakeServer.new

      pipeline(server, compiler: ->(_source, _path) { compiled }).handle_event(
        event(:changed, "a.html.slim", "div\n  p Hi\n", "div\n  p Hello\n")
      )

      invalidate = server.messages.map(&:first).find { |message| message[:type] == "invalidate" }

      assert_equal "static", invalidate[:scope]
      assert_equal "abcd1234", invalidate[:version]
      assert_equal [0, 0, 0], invalidate[:node_path]
    end

    test "a Slim attribute edit without a compiler is a static invalidate" do
      server = FakeServer.new

      pipeline(server).handle_event(event(:changed, "a.html.slim", "p.old Hi\n", "p.new Hi\n"))

      message, = server.messages.first

      assert_equal "invalidate", message[:type]
      assert_equal "static", message[:scope]
    end

    test "a structural Slim edit fetches and remaps slots across the insertion" do
      server = FakeServer.new
      results = [
        compiled(version: "v1", slot_entries: [{ index: 0, type: :child, node_path: [0, 1, 0] }]),
        compiled(version: "v2", slot_entries: [{ index: 0, type: :child, node_path: [0, 2, 0] }])
      ]
      subject = pipeline(server, compiler: ->(_source, _path) { results.shift })

      subject.handle_event(event(:changed, "a.html.slim", "div\n  h1 Hi\n  p = @a\n", "div\n  h1 Hey\n  p = @a\n"))
      subject.handle_event(event(:changed, "a.html.slim", "div\n  h1 Hey\n  p = @a\n", "div\n  h1 Hey\n  h2 Sub\n  p = @a\n"))

      messages = server.messages.map(&:first)
      schema = messages.reverse.find { |message| message[:type] == "schema" }
      invalidate = messages.reverse.find { |message| message[:type] == "invalidate" }

      assert_equal "fetch", invalidate[:scope]
      assert_equal({ "slots" => { "0" => 0 } }, schema[:remap])
    end

    test "a Slim parse error broadcasts an error message" do
      server = FakeServer.new

      pipeline(server).handle_event(event(:changed, "a.html.slim", "p Hi\n", "a(href=\"x\"\n"))

      message, = server.messages.first

      assert_equal "error", message[:type]
      assert_equal 1, message[:errors].first[:line]
    end

    test "broken Slim templates are remembered by parsing them as Slim" do
      subject = pipeline(FakeServer.new)

      assert_equal ["b.html.slim"], subject.remember_broken("a.html.slim" => "p Hi\n", "b.html.slim" => "a(href=\"x\"\n")
    end
  end
end
