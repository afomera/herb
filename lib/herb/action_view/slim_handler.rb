# frozen_string_literal: true
# typed: false

require_relative "../../herb"
require_relative "../engine"
require_relative "output_buffer_engine"

module Herb
  module ActionView
    # An Action View template handler that compiles `.slim` templates with `Herb::Engine` instead of
    # the Slim gem. Herb parses the Slim into its HTML+ERB tree with `exact_semantics`, so the page
    # renders what the Slim gem renders, and everything the engine does for ERB applies: debug
    # markers pointing at Slim lines, validators, registered visitors (`Herb::Engine.register_visitor`),
    # and Ruby errors reported on the Slim line they came from.
    #
    # It is opt-in. Register it for `:slim` from an initializer, which replaces the Slim gem's
    # handler (slim-rails registers its own in a Railtie that runs earlier):
    #
    #     # config/initializers/herb_slim.rb
    #     require "herb/action_view/slim_handler"
    #
    #     Herb::ActionView::SlimHandler.debug = Rails.env.development?
    #
    #     ActiveSupport.on_load(:action_view) do
    #       ActionView::Template.register_template_handler :slim, Herb::ActionView::SlimHandler
    #     end
    #
    # To move over a directory at a time, keep the Slim gem's handler for everything else:
    #
    #     handler = Herb::ActionView::SlimHandler.new(
    #       only: ->(template) { template.identifier.include?("/app/views/admin/") },
    #       fallback: Slim::RailsTemplate.new
    #     )
    #
    #     ActionView::Template.register_template_handler :slim, handler
    #
    # `only:` gets the template, and the source too when it takes two arguments. With
    # `fallback_on_errors: true`, a template Herb can't parse yet is compiled by the fallback instead,
    # and logged once:
    #
    #     handler = Herb::ActionView::SlimHandler.new(
    #       fallback: Slim::RailsTemplate.new,
    #       fallback_on_errors: true
    #     )
    #
    # The template can be an `ActionView::Template` or a template-like object from another library.
    # ViewComponent passes a struct with `identifier`, `short_identifier`, `format` and `type` (and
    # no `source`, which it passes as the second argument), whose `identifier` is the component's
    # template file, or its `.rb` file for an inline template.
    #
    # The project's Slim settings (`slim:` in `.herb.yml`) are read from `Herb.configuration`.
    class SlimHandler # rubocop:disable Metrics/ClassLength
      class << self
        # Adds `Herb::Engine::DebugVisitor` to templates under the project path, which is what the
        # dev tools overlay reads. Off by default.
        attr_accessor :debug #: bool

        # Extra visitors for every template this handler compiles, as a list or a callable taking the
        # `ActionView::Template`. `Herb::Engine.register_visitor` applies to every engine instead.
        attr_accessor :visitors #: (Array[untyped] | ^(untyped) -> Array[untyped])?

        # Where the templates the overlay can open live. Defaults to `Rails.root`.
        attr_writer :project_path #: String?

        # Where `fallback_on_errors:` logs the templates it hands to the fallback. Defaults to `Rails.logger`.
        attr_writer :logger #: untyped

        # The engine class to compile with. Defaults to Rails' `ActionView::Template::Handlers::ERB::Herb`
        # when Rails ships one (8.2), and to `Herb::ActionView::OutputBufferEngine` otherwise.
        attr_writer :engine_class #: Class?

        #: () -> String?
        def project_path
          @project_path || (defined?(::Rails) && ::Rails.respond_to?(:root) && ::Rails.root&.to_s) || nil
        end

        #: () -> untyped
        def logger
          @logger || (defined?(::Rails) && ::Rails.respond_to?(:logger) && ::Rails.logger) || nil
        end

        #: () -> Class
        def engine_class
          @engine_class || default_engine_class
        end

        #: () -> Class
        def default_engine_class
          if defined?(::ActionView::Template::Handlers::ERB::Herb)
            ::ActionView::Template::Handlers::ERB::Herb
          else
            OutputBufferEngine
          end
        end

        def call(template, source = nil)
          default.call(template, source)
        end

        def default
          @default ||= new
        end

        def reset!
          @debug = false
          @visitors = nil
          @project_path = nil
          @engine_class = nil
          @logger = nil
          @default = nil
        end
      end

      self.debug = false

      # The errors `fallback_on_errors:` hands a template to the fallback for: Herb couldn't parse it,
      # or compiled it to Ruby that doesn't parse. Validator errors still raise.
      FALLBACK_ERRORS = [::Herb::Engine::ParseError, ::Herb::Engine::InvalidRubyError].freeze

      POSITIONAL_PARAMETERS = [:req, :opt].freeze #: Array[Symbol]

      #: (?only: untyped, ?fallback: untyped, ?fallback_on_errors: bool, ?engine_class: Class?, ?visitors: untyped) -> void
      def initialize(only: nil, fallback: nil, fallback_on_errors: false, engine_class: nil, visitors: nil)
        raise ArgumentError, "`only:` needs a `fallback:` handler for the templates it leaves out" if only && !fallback
        raise ArgumentError, "`fallback_on_errors:` needs a `fallback:` handler" if fallback_on_errors && !fallback

        @only = only
        @only_takes_source = only && takes_source?(only)
        @fallback = fallback
        @fallback_on_errors = fallback_on_errors
        @engine_class = engine_class
        @visitors = visitors
        @logged_fallbacks = {}
      end

      def call(template, source = nil)
        source = source_for(template, source)

        return @fallback.call(template, source) unless herb?(template, source)

        compile(template, source)
      rescue *FALLBACK_ERRORS => e
        raise unless @fallback_on_errors

        log_fallback(template, e)

        @fallback.call(template, source)
      end

      def supports_streaming?
        true
      end

      private

      #: (untyped, String) -> String
      def compile(template, source)
        (@engine_class || self.class.engine_class).new(source, engine_options(template)).src
      end

      # The source Action View passes as the second argument, or the template's own. ViewComponent's
      # template struct has no `source`.
      #: (untyped, String?) -> String
      def source_for(template, source)
        source ||= template.source if template.respond_to?(:source)

        raise ArgumentError, "#{template_name(template)} has no source, and none was passed to the handler" if source.nil?

        source.to_s
      end

      #: (untyped, String) -> bool
      def herb?(template, source)
        return true unless @only

        @only_takes_source ? @only.call(template, source) : @only.call(template)
      end

      #: (untyped) -> bool
      def takes_source?(callable)
        callable = callable.method(:call) unless callable.respond_to?(:parameters)
        parameters = callable.parameters

        parameters.any? { |type, _| type == :rest } || parameters.count { |type, _| POSITIONAL_PARAMETERS.include?(type) } > 1
      end

      #: (untyped, Exception) -> void
      def log_fallback(template, error)
        name = template_name(template)
        reason = error.message.to_s.strip.lines.first.to_s.strip.sub(/\A\S+?:(\d+):(\d+): /, 'line \\1:\\2: ')

        return if @logged_fallbacks[name] == reason

        @logged_fallbacks[name] = reason

        self.class.logger&.info("[Herb] #{name} is rendered by #{@fallback.class}, since Herb could not compile it: #{reason}")
      end

      #: (untyped, Symbol) -> untyped
      def template_attribute(template, name)
        template.respond_to?(name) ? template.public_send(name) : nil
      end

      #: (untyped) -> String
      def template_name(template)
        (template_attribute(template, :short_identifier) || template_attribute(template, :identifier) || template.class.name).to_s
      end

      #: (untyped) -> Hash[Symbol, untyped]
      def engine_options(template)
        options = {
          language: "slim",
          filename: template_attribute(template, :identifier),
          escape: ::ActionView::Template::Handlers::ERB.escape_ignore_list.include?(template_attribute(template, :type)),
          visitors: visitors_for(template),
        }

        project_path = self.class.project_path
        options[:project_path] = project_path if project_path

        annotate(template, options)
      end

      #: (untyped, Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def annotate(template, options)
        return options unless ::ActionView::Base.try(:annotate_rendered_view_with_filenames) && template_attribute(template, :format) == :html

        name = template_name(template)

        options.merge(
          preamble: "@output_buffer.safe_append='<!-- BEGIN #{name} -->';",
          postamble: "@output_buffer.safe_append='<!-- END #{name} -->';@output_buffer"
        )
      end

      #: (untyped) -> Array[untyped]
      def visitors_for(template)
        visitors = [*configured(self.class.visitors, template), *configured(@visitors, template)]

        visitors << ::Herb::Engine::DebugVisitor.new if self.class.debug && local_template?(template)

        visitors
      end

      #: (untyped, untyped) -> Array[untyped]
      def configured(visitors, template)
        return [] unless visitors

        Array(visitors.respond_to?(:call) ? visitors.call(template) : visitors)
      end

      #: (untyped) -> bool
      def local_template?(template)
        project_path = self.class.project_path
        identifier = template_attribute(template, :identifier).to_s

        return false if identifier.empty?
        return true unless project_path

        identifier.start_with?(project_path.to_s)
      end
    end
  end
end

require_relative "../engine/visitors/debug_visitor"
