# frozen_string_literal: true

require_relative "test_helper"

class TemplateLanguageTest < Minitest::Spec
  test "parses .slim files as Slim" do
    assert_equal "slim", Herb::TemplateLanguage.for_path("app/views/users/show.html.slim")
    assert_equal "slim", Herb::TemplateLanguage.for_path("app/views/users/_card.slim")
    assert_equal "slim", Herb::TemplateLanguage.for_path(Pathname.new("SHOW.HTML.SLIM"))
  end

  test "parses everything else as ERB" do
    assert_equal "erb", Herb::TemplateLanguage.for_path("app/views/users/show.html.erb")
    assert_equal "erb", Herb::TemplateLanguage.for_path("public/index.html")
    assert_equal "erb", Herb::TemplateLanguage.for_path("app/views/slim/show.html.erb")
    assert_equal "erb", Herb::TemplateLanguage.for_path(nil)
  end

  test "erb? and slim?" do
    assert Herb::TemplateLanguage.slim?("show.html.slim")
    refute Herb::TemplateLanguage.erb?("show.html.slim")
    assert Herb::TemplateLanguage.erb?("show.html.erb")
  end
end
