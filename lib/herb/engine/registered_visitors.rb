# frozen_string_literal: true
# typed: false

module Herb
  class Engine
    # Visitors an application registers once, usually from an initializer, and every `Herb::Engine`
    # compile then runs, whichever integration created the engine (Rails, ReActionView, a template
    # handler of your own). It is the Herb counterpart of `Slim::Engine.after` / `Temple::Engine.use`:
    # a compile-time pass over the template, written once, that applies to every template.
    #
    #     class StripTestIds < Herb::Visitor
    #       def visit_html_open_tag_node(node)
    #         node.children.reject! { |child| child.is_a?(Herb::AST::HTMLAttributeNode) && ... }
    #         super
    #       end
    #     end
    #
    #     Herb::Engine.register_visitor(StripTestIds) unless Rails.env.test?
    #
    # A registration is one of:
    #
    # - a visitor class, instantiated for every compile, which suits a visitor that keeps state;
    # - a block, called for every compile with the template's `Herb::Visitor::Context` and returning a
    #   visitor, or `nil` to skip that template;
    # - a visitor instance, shared by every compile, which suits a visitor that keeps no state.
    #
    # Registered visitors run after the visitors the engine was given, unless `before:` or `after:`
    # names a visitor class to place them against. Declared ordering (`reads_erb_source?`,
    # `rewrites_erb_source?`, `inlines_renders?`) is honored the same as for any stack. Pass
    # `registered_visitors: false` to `Herb::Engine.new` to compile a template without them.
    module RegisteredVisitors
      Registration = Data.define(:visitor, :factory, :before, :after)

      MUTEX = Mutex.new

      # One list for `Herb::Engine` and every subclass of it, so a registration made on either
      # applies to all of them.
      @registrations = [] #: Array[Registration]
      @registrations.freeze

      #: () -> Array[Registration]
      def self.registrations
        @registrations
      end

      #: (Array[Registration]) -> void
      def self.registrations=(registrations)
        @registrations = registrations
      end

      # Registers a visitor for every compile and returns the registration, which
      # `unregister_visitor` takes to remove it again.
      #: (?untyped, ?before: Module?, ?after: Module?) ?{ (Herb::Visitor::Context) -> untyped } -> Registration
      def register_visitor(visitor = nil, before: nil, after: nil, &factory)
        raise ArgumentError, "register_visitor takes a visitor, a visitor class or a block, not both" if visitor && factory
        raise ArgumentError, "register_visitor needs a visitor, a visitor class or a block" unless visitor || factory
        raise ArgumentError, "register_visitor takes `before:` or `after:`, not both" if before && after

        registration = Registration.new(visitor: visitor, factory: factory, before: before, after: after)

        MUTEX.synchronize { RegisteredVisitors.registrations = [*registered_visitors, registration].freeze }

        registration
      end

      #: (Registration) -> bool
      def unregister_visitor(registration)
        MUTEX.synchronize do
          remaining = registered_visitors.reject { |entry| entry.equal?(registration) }
          removed = remaining.length != registered_visitors.length

          RegisteredVisitors.registrations = remaining.freeze

          removed
        end
      end

      #: () -> Array[Registration]
      def registered_visitors
        RegisteredVisitors.registrations
      end

      #: () -> void
      def reset_registered_visitors!
        MUTEX.synchronize { RegisteredVisitors.registrations = [] }
      end

      # Adds the registered visitors for this compile to `stack`.
      #: (Herb::Visitor::Stack, Herb::Visitor::Context) -> Herb::Visitor::Stack
      def apply_registered_visitors(stack, context)
        registrations = registered_visitors

        return stack if registrations.empty?

        registrations.each do |registration|
          visitor = build_registered_visitor(registration, context)

          next unless visitor

          place_registered_visitor(stack, visitor, registration)
        end

        Herb::Visitor::Stack.arrange(stack)
      end

      private

      #: (Registration, Herb::Visitor::Context) -> untyped
      def build_registered_visitor(registration, context)
        return registration.factory.call(context) if registration.factory
        return registration.visitor.new if registration.visitor.is_a?(Class)

        registration.visitor
      end

      #: (Herb::Visitor::Stack, untyped, Registration) -> void
      def place_registered_visitor(stack, visitor, registration)
        anchor = registration.before || registration.after

        if anchor && stack.include_visitor?(anchor)
          registration.before ? stack.insert_before(anchor, visitor) : stack.insert_after(anchor, visitor)
        else
          stack.use(visitor)
        end
      end
    end

    extend RegisteredVisitors
  end
end
