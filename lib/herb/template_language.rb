# frozen_string_literal: true
# typed: true

module Herb
  # Chooses the template language a file is parsed with, going by its extension.
  #
  #     Herb::TemplateLanguage.for_path("app/views/users/show.html.slim") #=> "slim"
  #     Herb::TemplateLanguage.for_path("app/views/users/show.html.erb")  #=> "erb"
  #
  # Mirrors `languageForPath` in `@herb-tools/core`.
  module TemplateLanguage
    SLIM_EXTENSIONS = [".slim"].freeze #: Array[String]

    #: ((String | Pathname)?) -> bool
    def self.slim?(path)
      return false if path.nil?

      name = path.to_s.downcase

      SLIM_EXTENSIONS.any? { |extension| name.end_with?(extension) }
    end

    #: ((String | Pathname)?) -> String
    def self.for_path(path)
      slim?(path) ? "slim" : "erb"
    end

    # Whether a file is an ERB template, as opposed to another language Herb parses into the same tree.
    #: ((String | Pathname)?) -> bool
    def self.erb?(path)
      for_path(path) == "erb"
    end

    # The parser options that build the tree `Herb::Engine` compiles the template at `path` from, for
    # code that analyzes a template and has to agree with the compile about its nodes and their
    # paths. None for ERB. A Slim template is parsed as Slim with the project's Slim settings and
    # `exact_semantics`, the way the engine parses it.
    #: ((String | Pathname)?, ?untyped) -> Hash[Symbol, untyped]
    def self.compile_parser_options(path, configuration = nil)
      return {} unless slim?(path)

      configuration ||= Herb.configuration

      configuration.slim_parser_options.merge(language: "slim", exact_semantics: true)
    end
  end
end
