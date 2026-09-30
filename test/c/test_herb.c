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

TEST(test_herb_parses_slim_with_configured_shortcuts_in_both_modes)
  static const hb_string_T shortcuts[] = {
    { .data = (char*) "~", .length = 1 },
    { .data = (char*) "data-testid", .length = 11 },
    { .data = (char*) ".", .length = 1 },
    { .data = (char*) "class", .length = 5 },
  };

  static const hb_string_T merge_attrs[] = {
    { .data = (char*) "class", .length = 5 },
    { .data = (char*) " ", .length = 1 },
    { .data = (char*) "data-controller", .length = 15 },
    { .data = (char*) " ", .length = 1 },
  };

  const char* source = "div.a~t data-controller=\"x\" data-controller=y class=z Hello\n"
                       "*{ tag: \"h1\", id: \"t\" } Title\n"
                       "*attrs Dynamic\n"
                       "div *attrs data={ a: 1 } Splat\n";

  for (int exact = 0; exact <= 1; exact++) {
    parser_options_T options = HERB_DEFAULT_PARSER_OPTIONS;
    options.language = HERB_LANGUAGE_SLIM;
    options.exact_semantics = exact == 1;
    options.slim_shortcuts = shortcuts;
    options.slim_shortcut_count = 2;
    options.slim_merge_attrs = merge_attrs;
    options.slim_merge_attr_count = 2;

    hb_allocator_T allocator = hb_allocator_with_malloc();
    AST_DOCUMENT_NODE_T* document = herb_parse(source, &options, &allocator);

    ck_assert_ptr_nonnull(document);
    ck_assert_int_eq(hb_array_size(document->base.errors), 0);

    AST_NODE_T* first = hb_array_get(document->children, exact ? 1 : 0);
    ck_assert_int_eq(first->type, AST_HTML_ELEMENT_NODE);

    ast_node_free((AST_NODE_T*) document, &allocator);
    hb_allocator_destroy(&allocator);
  }
END

TCase *herb_tests(void) {
  TCase *herb = tcase_create("Herb");

  tcase_add_test(herb, test_herb_version);
  tcase_add_test(herb, test_herb_frees_an_error_with_an_empty_string_field);
  tcase_add_test(herb, test_herb_parses_and_frees_a_slim_template);
  tcase_add_test(herb, test_herb_parses_slim_with_configured_shortcuts_in_both_modes);

  return herb;
}
