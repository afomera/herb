# frozen_string_literal: true
# typed: true

require_relative "../../herb"
require_relative "../configuration"
require_relative "../template_language"

module Herb
  module Dev
    # Says what kind of change an edit to a template is.
    #
    # The watcher hands it the previous and current source, and everything downstream decides
    # what to do from the kind alone. `:none` and `:whitespace` render the same as before, so
    # nothing needs to happen. `:static` moved markup without touching any ERB. `:dynamic` is
    # everything else. `:parse_error` carries the errors instead of a diff.
    #
    # The kinds are ordered checks, and the whitespace check has to come before the patchable
    # one. `whitespace_changed` is not a patchable operation, so a reindent classified in the
    # wrong order would read as `:dynamic` and cost a page reload.
    #
    # The diff parses without the configured ERB openers, so a custom opener reads as text on
    # both sides and its edits would pass the patchable check. With openers configured, no
    # change classifies better than `:dynamic`.
    #
    # A Slim template is parsed as Slim, with the project's Slim settings, so its parse errors point
    # at Slim lines. `Herb.diff` only diffs HTML+ERB, so any edit to a Slim template that still
    # parses is `:dynamic`, and browsers refetch or reload the page that rendered it.
    #
    class Classifier
      PATCHABLE_TYPES = ["text_changed", "attribute_value_changed", "attribute_added", "attribute_removed"].freeze #: Array[String]

      Classification = Data.define(
        :kind,       #: Symbol
        :operations, #: Array[Herb::Diff::Operation]
        :node_path,  #: Array[Integer]
        :errors      #: Array[Herb::Errors::Error]
      )

      #: (Array[Herb::Diff::Operation]) -> bool
      def self.can_patch?(operations)
        operations.all? { |operation|
          next false unless PATCHABLE_TYPES.include?(operation.type.to_s)
          next false if operation.new_node&.type&.to_s&.include?("ERB")
          next false if operation.old_node&.type&.to_s&.include?("ERB")

          true
        }
      end

      #: (?configuration: Herb::Configuration?) -> void
      def initialize(configuration: nil)
        @configuration = configuration
        @parser_options = configuration&.parser_options || {} #: Hash[Symbol, untyped]
      end

      # The options a template at `path` is parsed with: the project's parser options, and for a
      # template that isn't ERB its language and settings.
      #: (String?) -> Hash[Symbol, untyped]
      def parser_options_for(path)
        return @parser_options if path.nil? || TemplateLanguage.erb?(path)

        (@configuration || Herb::Configuration.default).parser_options_for_path(path)
      end

      #: (String, String, ?String?) -> Classification
      def call(previous, current, path = nil)
        return call_without_diff(previous, current, path) unless path.nil? || TemplateLanguage.erb?(path)

        parse = Herb.parse(current, strict: true, analyze: true, **@parser_options)

        return classification(:parse_error, errors: parse.errors) if parse.errors.any?

        diff = Herb.diff(previous, current, track_whitespace_changes: true)

        return classification(:none) if diff.identical?

        operations = diff.operations
        significant = operations.reject { |operation| operation.type.to_s == "whitespace_changed" }

        return classification(:whitespace, operations: operations) if significant.empty?

        kind = self.class.can_patch?(significant) && @parser_options.empty? ? :static : :dynamic

        classification(kind, operations: operations, node_path: covering_path(significant))
      end

      private

      #: (String, String, String) -> Classification
      def call_without_diff(previous, current, path)
        parse = Herb.parse(current, strict: true, analyze: true, **parser_options_for(path))

        return classification(:parse_error, errors: parse.errors) if parse.errors.any?
        return classification(:none) if previous == current

        classification(:dynamic)
      end

      #: (Symbol, ?operations: Array[Herb::Diff::Operation], ?node_path: Array[Integer], ?errors: Array[Herb::Errors::Error]) -> Classification
      def classification(kind, operations: [], node_path: [], errors: [])
        Classification.new(kind: kind, operations: operations, node_path: node_path, errors: errors)
      end

      #: (Array[Herb::Diff::Operation]) -> Array[Integer]
      def covering_path(operations)
        paths = operations.map(&:path)

        paths.reduce { |common, path| common.zip(path).take_while { |left, right| left == right }.map(&:first) } || []
      end
    end
  end
end
