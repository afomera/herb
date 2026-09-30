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
  end
end
