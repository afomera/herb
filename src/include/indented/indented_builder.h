#ifndef HERB_INDENTED_BUILDER_H
#define HERB_INDENTED_BUILDER_H

// Helpers for building a regular Herb HTML+ERB syntax tree out of an
// indentation-based template language (Slim, and later Haml).
//
// Tokens that correspond to real source text (tag names, attribute names and
// values, text, Ruby code) point into the source and carry exact locations and
// byte ranges. Tokens that only exist in the equivalent HTML+ERB (`<`, `>`, `</`,
// `<%=`, `%>`, `="`, ...) are synthetic: they own their value and get a
// zero-width location at a nearby source position.
//
// The builder also collects the Ruby code of every ERB node it creates, in
// document order, so that the whole template can be checked for Ruby syntax
// errors and resolve local variables once the tree has been built (see `indented_builder_ruby_program`).

#include "../analyze/ruby_program.h"
#include "../ast/ast_nodes.h"
#include "../lexer/token_struct.h"
#include "../lib/hb_allocator.h"
#include "../lib/hb_array.h"
#include "../lib/hb_buffer.h"
#include "../lib/hb_string.h"
#include "../parser/parser_options.h"
#include "indented_source.h"

#include <stdbool.h>
#include <stdint.h>

typedef struct INDENTED_BUILDER_STRUCT {
  const indented_source_T* source;
  const parser_options_T* options;
  hb_allocator_T* allocator;
  hb_string_T element_source;
  hb_buffer_T ruby;
  hb_array_T* ruby_segments;
} indented_builder_T;

void indented_builder_init(
  indented_builder_T* builder,
  const indented_source_T* source,
  const parser_options_T* options,
  hb_string_T element_source,
  hb_allocator_T* allocator
);

void indented_builder_free(indented_builder_T* builder);

position_T indented_builder_position(const indented_builder_T* builder, uint32_t offset);

token_T* indented_source_token(indented_builder_T* builder, uint32_t from, uint32_t to, token_type_T type);
token_T* indented_synthetic_token(indented_builder_T* builder, const char* value, token_type_T type, uint32_t at);
token_T* indented_owned_token(
  indented_builder_T* builder,
  hb_string_T value,
  token_type_T type,
  uint32_t from,
  uint32_t to
);

AST_HTML_TEXT_NODE_T* indented_text_node(indented_builder_T* builder, hb_string_T content, uint32_t from, uint32_t to);
AST_LITERAL_NODE_T* indented_literal_node(indented_builder_T* builder, hb_string_T content, uint32_t from, uint32_t to);
AST_WHITESPACE_NODE_T* indented_whitespace_node(indented_builder_T* builder, uint32_t at);

// `<%= code %>`, `<%== code %>`, `<% code %>`. `node_from` is where the construct starts in the source
// (e.g. the `=` indicator), `code_from`/`code_to` delimit the Ruby code. `suffix` is appended to the code
// (e.g. " do" for Slim's implicit `do`), `override` replaces the code entirely (both may be NULL).
AST_NODE_T* indented_erb_node(
  indented_builder_T* builder,
  const char* opening,
  uint32_t node_from,
  uint32_t code_from,
  uint32_t code_to,
  const char* suffix,
  const char* override
);

// A fully synthetic ERB node, e.g. the implicit `<% end %>` closing a Slim control block.
AST_NODE_T* indented_synthetic_erb_node(
  indented_builder_T* builder,
  const char* opening,
  const char* content,
  uint32_t at
);

AST_ERB_COMMENT_NODE_T* indented_erb_comment_node(
  indented_builder_T* builder,
  uint32_t node_from,
  uint32_t content_from,
  uint32_t content_to
);

AST_HTML_OPEN_TAG_NODE_T* indented_open_tag_node(indented_builder_T* builder, token_T* tag_name, uint32_t from);
// Appends an attribute (or ERB node) to the open tag, preceded by a synthetic " " whitespace node at `at`.
void indented_open_tag_append(
  indented_builder_T* builder,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  AST_NODE_T* child,
  uint32_t at
);
void indented_open_tag_finish(
  indented_builder_T* builder,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  const char* closing,
  uint32_t at,
  bool is_void
);

// Builds the element around `open_tag`. A synthetic `</tag>` close tag is added unless `is_void` or `self_closing`.
AST_HTML_ELEMENT_NODE_T* indented_element_node(
  indented_builder_T* builder,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  hb_array_T* body,
  bool is_void,
  bool self_closing,
  uint32_t to
);

AST_HTML_ATTRIBUTE_NAME_NODE_T* indented_attribute_name_node(
  indented_builder_T* builder,
  hb_string_T name,
  uint32_t from,
  uint32_t to
);

AST_HTML_ATTRIBUTE_NODE_T* indented_attribute_node(
  indented_builder_T* builder,
  AST_HTML_ATTRIBUTE_NAME_NODE_T* name,
  token_T* equals,
  token_T* open_quote,
  hb_array_T* value_children,
  token_T* close_quote,
  uint32_t from,
  uint32_t to
);

// The Ruby code of every ERB node built so far, for `herb_analyze_parse_tree_with_ruby_program`.
// Valid until `indented_builder_free`.
herb_ruby_program_T indented_builder_ruby_program(const indented_builder_T* builder);

#endif
