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
    # The project's Slim settings (`slim:` in `.herb.yml`) are read from `Herb.configuration`.
    class SlimHandler
      class << self
        # Adds `Herb::Engine::DebugVisitor` to templates under the project path, which is what the
        # dev tools overlay reads. Off by default.
        attr_accessor :debug #: bool

        # Extra visitors for every template this handler compiles, as a list or a callable taking the
        # `ActionView::Template`. `Herb::Engine.register_visitor` applies to every engine instead.
        attr_accessor :visitors #: (Array[untyped] | ^(untyped) -> Array[untyped])?

        # Where the templates the overlay can open live. Defaults to `Rails.root`.
        attr_writer :project_path #: String?

        # The engine class to compile with. Defaults to Rails' `ActionView::Template::Handlers::ERB::Herb`
        # when Rails ships one (8.2), and to `Herb::ActionView::OutputBufferEngine` otherwise.
        attr_writer :engine_class #: Class?

        #: () -> String?
        def project_path
          @project_path || (defined?(::Rails) && ::Rails.respond_to?(:root) && ::Rails.root&.to_s) || nil
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
          @default = nil
        end
      end

      self.debug = false

      #: (?only: (^(untyped) -> boolish)?, ?fallback: untyped, ?engine_class: Class?, ?visitors: untyped) -> void
      def initialize(only: nil, fallback: nil, engine_class: nil, visitors: nil)
        raise ArgumentError, "`only:` needs a `fallback:` handler for the templates it leaves out" if only && !fallback

        @only = only
        @fallback = fallback
        @engine_class = engine_class
        @visitors = visitors
      end

      def call(template, source = nil)
        source ||= template.source

        return @fallback.call(template, source) if @only && !@only.call(template)

        (@engine_class || self.class.engine_class).new(source.to_s, engine_options(template)).src
      end

      def supports_streaming?
        true
      end

      private

      #: (untyped) -> Hash[Symbol, untyped]
      def engine_options(template)
        options = {
          language: "slim",
          filename: template.identifier,
          escape: ::ActionView::Template::Handlers::ERB.escape_ignore_list.include?(template.type),
          visitors: visitors_for(template),
        }

        project_path = self.class.project_path
        options[:project_path] = project_path if project_path

        annotate(template, options)
      end

      #: (untyped, Hash[Symbol, untyped]) -> Hash[Symbol, untyped]
      def annotate(template, options)
        return options unless ::ActionView::Base.try(:annotate_rendered_view_with_filenames) && template.format == :html

        options.merge(
          preamble: "@output_buffer.safe_append='<!-- BEGIN #{template.short_identifier} -->';",
          postamble: "@output_buffer.safe_append='<!-- END #{template.short_identifier} -->';@output_buffer"
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
        identifier = template.identifier.to_s

        return true unless project_path

        identifier.start_with?(project_path.to_s)
      end
    end
  end
end

require_relative "../engine/visitors/debug_visitor"
