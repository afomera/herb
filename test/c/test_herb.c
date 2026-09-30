#include "include/test.h"
#include "../../src/include/herb.h"
#include "../../src/include/lib/hb_allocator.h"

TEST(test_herb_version)
  ck_assert_str_eq(herb_version(), "0.11.0");
END

TEST(test_herb_frees_an_error_with_an_empty_string_field)
  parser_options_T options = HERB_DEFAULT_PARSER_OPTIONS;
  options.strict_locals = true;

  hb_allocator_T allocator = hb_allocator_with_malloc();

  AST_DOCUMENT_NODE_T* document = herb_parse("<%# locals: %>", &options, &allocator);

  ck_assert_ptr_nonnull(document);

  ast_node_free((AST_NODE_T*) document, &allocator);
  hb_allocator_destroy(&allocator);
END

TEST(test_herb_parses_and_frees_a_slim_template)
  parser_options_T options = HERB_DEFAULT_PARSER_OPTIONS;
  options.language = HERB_LANGUAGE_SLIM;
  options.action_view_helpers = true;

  const char* source = "doctype html\n"
                       "#main.a.b class=\"c\" data-x=value\n"
                       "  - if admin\n"
                       "    p Hello #{name}\n"
                       "  - else\n"
                       "    = link_to path do\n"
                       "      span Hi\n"
                       "  / comment\n"
                       "  javascript:\n"
                       "    alert(1);\n";

  hb_allocator_T allocator = hb_allocator_with_malloc();

  AST_DOCUMENT_NODE_T* document = herb_parse(source, &options, &allocator);

  ck_assert_ptr_nonnull(document);
  ck_assert_int_eq(hb_array_size(document->base.errors), 0);
  ck_assert_int_eq(hb_array_size(document->children), 2);

  AST_NODE_T* element = hb_array_get(document->children, 1);
  ck_assert_int_eq(element->type, AST_HTML_ELEMENT_NODE);

  ast_node_free((AST_NODE_T*) document, &allocator);
  hb_allocator_destroy(&allocator);
END

TCase *herb_tests(void) {
  TCase *herb = tcase_create("Herb");

  tcase_add_test(herb, test_herb_version);
  tcase_add_test(herb, test_herb_frees_an_error_with_an_empty_string_field);
  tcase_add_test(herb, test_herb_parses_and_frees_a_slim_template);

  return herb;
}
