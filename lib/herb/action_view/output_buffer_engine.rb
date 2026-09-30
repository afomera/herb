# frozen_string_literal: true
# typed: false

require_relative "../engine"

module Herb
  module ActionView
    # `Herb::Engine` compiling for Action View: it appends to `@output_buffer` the way Rails' own
    # ERB handler does, so `ActiveSupport::SafeBuffer` decides what gets escaped and block helpers
    # capture their content.
    #
    # Rails 8.2 ships the same thing as `ActionView::Template::Handlers::ERB::Herb`, and
    # `SlimHandler` uses that one when it is there. This is for Rails 8.1 and earlier.
    class OutputBufferEngine < ::Herb::Engine
      def initialize(input, properties = {})
        @newline_pending = 0

        super(input, self.class.action_view_properties(properties))
      end

      def self.action_view_properties(properties)
        properties = properties.to_h.dup

        properties[:bufvar] ||= "@output_buffer"
        properties[:preamble] ||= ""
        properties[:postamble] ||= properties[:bufvar].to_s
        properties[:freeze_template_literals] = !::ActionView::Template.frozen_string_literal

        # Action View's output buffer does the escaping.
        properties.merge(escapefunc: "", attrfunc: nil, jsfunc: nil, cssfunc: nil)
      end

      private

      def add_text(text)
        return if text.empty?

        if text == "\n"
          @newline_pending += 1
        else
          with_buffer do
            @src << ".safe_append='"
            @src << ("\n" * @newline_pending) if @newline_pending.positive?
            @src << text.gsub(/['\\]/, '\\\\\&') << @text_end
          end

          @newline_pending = 0
        end
      end

      def add_expression(indicator, code)
        flush_newline_if_pending(@src)

        with_buffer do
          @src << ((indicator == "==") || @escape ? ".safe_expr_append=" : ".append=")

          if expression_block?
            @src << " " << code
          else
            @src << "(" << code << trailing_newline(code) << ")"
          end
        end
      end

      def add_code(code)
        flush_newline_if_pending(@src)
        super
      end

      def add_postamble(_)
        flush_newline_if_pending(@src)
        super
      end

      def align_to_source_line(line)
        flush_newline_if_pending(@src)
        super
      end

      def flush_newline_if_pending(src)
        return unless @newline_pending.positive?

        with_buffer { src << ".safe_append='#{"\n" * @newline_pending}" << @text_end }
        @newline_pending = 0
      end
    end
  end
end
