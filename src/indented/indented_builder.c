#include "../include/indented/indented_builder.h"
#include "../include/analyze/action_view/tag_helper_node_builders.h"
#include "../include/ast/ast_nodes.h"
#include "../include/lexer/token.h"
#include "../include/lib/hb_allocator.h"
#include "../include/lib/hb_array.h"
#include "../include/lib/hb_buffer.h"
#include "../include/lib/hb_string.h"
#include "../include/location/location.h"
#include "../include/prism/herb_prism_node.h"

#include <string.h>

void indented_builder_init(
  indented_builder_T* builder,
  const indented_source_T* source,
  const parser_options_T* options,
  hb_string_T element_source,
  hb_allocator_T* allocator
) {
  builder->source = source;
  builder->options = options;
  builder->allocator = allocator;
  builder->element_source = element_source;
  builder->ruby_segments = hb_array_init(16, allocator);

  hb_buffer_init(&builder->ruby, 256, allocator);
}

void indented_builder_free(indented_builder_T* builder) {
  if (builder->ruby_segments) {
    for (size_t index = 0; index < hb_array_size(builder->ruby_segments); index++) {
      hb_allocator_dealloc(builder->allocator, hb_array_get(builder->ruby_segments, index));
    }

    hb_array_free(&builder->ruby_segments);
  }

  hb_buffer_free(&builder->ruby);
}

position_T indented_builder_position(const indented_builder_T* builder, uint32_t offset) {
  return indented_source_position(builder->source, offset);
}

token_T* indented_source_token(indented_builder_T* builder, uint32_t from, uint32_t to, token_type_T type) {
  token_T* token = hb_allocator_alloc(builder->allocator, sizeof(token_T));
  if (!token) { return NULL; }

  token->value = hb_string_from_data(builder->source->source + from, to - from);
  token->owns_value = false;
  token->type = type;
  token->range = (range_T) { .from = from, .to = to };

  location_from_positions(
    &token->location,
    indented_builder_position(builder, from),
    indented_builder_position(builder, to)
  );

  return token;
}

token_T* indented_synthetic_token(indented_builder_T* builder, const char* value, token_type_T type, uint32_t at) {
  position_T position = indented_builder_position(builder, at);
  token_T* token = create_synthetic_token(builder->allocator, value, type, position, position);

  if (token) { token->range = (range_T) { .from = at, .to = at }; }

  return token;
}

token_T* indented_owned_token(
  indented_builder_T* builder,
  hb_string_T value,
  token_type_T type,
  uint32_t from,
  uint32_t to
) {
  token_T* token = hb_allocator_alloc(builder->allocator, sizeof(token_T));
  if (!token) { return NULL; }

  token->value = hb_string_copy(value, builder->allocator);
  token->owns_value = !hb_string_is_empty(token->value);
  token->type = type;
  token->range = (range_T) { .from = from, .to = to };

  location_from_positions(
    &token->location,
    indented_builder_position(builder, from),
    indented_builder_position(builder, to)
  );

  return token;
}

AST_HTML_TEXT_NODE_T* indented_text_node(indented_builder_T* builder, hb_string_T content, uint32_t from, uint32_t to) {
  return ast_html_text_node_init(
    content,
    indented_builder_position(builder, from),
    indented_builder_position(builder, to),
    NULL,
    builder->allocator
  );
}

AST_LITERAL_NODE_T* indented_literal_node(
  indented_builder_T* builder,
  hb_string_T content,
  uint32_t from,
  uint32_t to
) {
  return ast_literal_node_init(
    content,
    indented_builder_position(builder, from),
    indented_builder_position(builder, to),
    NULL,
    builder->allocator
  );
}

AST_WHITESPACE_NODE_T* indented_whitespace_node(indented_builder_T* builder, uint32_t at) {
  token_T* token = indented_synthetic_token(builder, " ", TOKEN_WHITESPACE, at);
  position_T position = indented_builder_position(builder, at);

  return ast_whitespace_node_init(token, position, position, NULL, builder->allocator);
}

static void record_ruby(
  indented_builder_T* builder,
  hb_string_T code,
  uint32_t source_from,
  uint32_t source_to,
  position_T start,
  position_T end
) {
  herb_ruby_segment_T* segment = hb_allocator_alloc(builder->allocator, sizeof(herb_ruby_segment_T));
  if (!segment) { return; }

  segment->program_from = (uint32_t) hb_buffer_length(&builder->ruby);
  hb_buffer_append_string(&builder->ruby, code);
  segment->program_to = (uint32_t) hb_buffer_length(&builder->ruby);
  hb_buffer_append_char(&builder->ruby, '\n');

  segment->source_from = source_from;
  segment->source_to = source_to;
  segment->start = start;
  segment->end = end;

  hb_array_append(builder->ruby_segments, segment);
}

void indented_builder_record_source_ruby(indented_builder_T* builder, uint32_t from, uint32_t to) {
  record_ruby(
    builder,
    hb_string_from_data(builder->source->source + from, to - from),
    from,
    to,
    indented_builder_position(builder, from),
    indented_builder_position(builder, to)
  );
}

// A few leading characters would change the meaning of the printed ERB tag (`<%%`, `<%#`, `<%==`, `<%-`),
// and a few trailing ones the meaning of its closing tag (`-%>`, `%%>`, `=%>`). Those get padded with a space.
static bool needs_leading_padding(char character) {
  return character == '%' || character == '#' || character == '=' || character == '-';
}

static bool needs_trailing_padding(char character) {
  return character == '%' || character == '=' || character == '-';
}

static AST_NODE_T* erb_node_from_tokens(
  indented_builder_T* builder,
  token_T* opening,
  token_T* content,
  token_T* closing,
  position_T start,
  position_T end
) {
  return (AST_NODE_T*) ast_erb_content_node_init(
    opening,
    content,
    closing,
    NULL,
    false,
    false,
    HERB_PRISM_NODE_EMPTY,
    start,
    end,
    NULL,
    builder->allocator
  );
}

AST_NODE_T* indented_erb_node(
  indented_builder_T* builder,
  const char* opening,
  uint32_t node_from,
  uint32_t code_from,
  uint32_t code_to,
  const char* suffix,
  const char* override
) {
  hb_string_T code = hb_string_from_data(builder->source->source + code_from, code_to - code_from);
  token_T* content = NULL;

  bool leading_padding = !override && code.length > 0 && needs_leading_padding(code.data[0]);
  bool trailing_padding = !override && !suffix && code.length > 0 && needs_trailing_padding(code.data[code.length - 1]);

  if (override || suffix || leading_padding || trailing_padding) {
    hb_buffer_T buffer;
    hb_buffer_init(&buffer, code.length + 16, builder->allocator);

    if (override) {
      hb_buffer_append(&buffer, override);
    } else {
      if (leading_padding) { hb_buffer_append_char(&buffer, ' '); }
      hb_buffer_append_string(&buffer, code);
      if (suffix) { hb_buffer_append(&buffer, suffix); }
      if (trailing_padding) { hb_buffer_append_char(&buffer, ' '); }
    }

    hb_string_T value = hb_string_from_data(hb_buffer_value(&buffer), hb_buffer_length(&buffer));
    content = indented_owned_token(builder, value, TOKEN_ERB_CONTENT, code_from, code_to);
    hb_buffer_free(&buffer);
  } else {
    content = indented_source_token(builder, code_from, code_to, TOKEN_ERB_CONTENT);
  }

  token_T* tag_opening = indented_synthetic_token(builder, opening, TOKEN_ERB_START, node_from);
  token_T* tag_closing = indented_synthetic_token(builder, "%>", TOKEN_ERB_END, code_to);

  position_T start = indented_builder_position(builder, node_from);
  position_T end = indented_builder_position(builder, code_to);

  record_ruby(builder, content->value, code_from, code_to, start, end);

  return erb_node_from_tokens(builder, tag_opening, content, tag_closing, start, end);
}

AST_NODE_T* indented_synthetic_erb_node(
  indented_builder_T* builder,
  const char* opening,
  const char* content,
  uint32_t at
) {
  token_T* tag_opening = indented_synthetic_token(builder, opening, TOKEN_ERB_START, at);
  token_T* content_token = indented_synthetic_token(builder, content, TOKEN_ERB_CONTENT, at);
  token_T* tag_closing = indented_synthetic_token(builder, "%>", TOKEN_ERB_END, at);
  position_T position = indented_builder_position(builder, at);

  record_ruby(builder, content_token->value, at, at, position, position);

  return erb_node_from_tokens(builder, tag_opening, content_token, tag_closing, position, position);
}

AST_ERB_COMMENT_NODE_T* indented_erb_comment_node(
  indented_builder_T* builder,
  uint32_t node_from,
  uint32_t content_from,
  uint32_t content_to
) {
  token_T* tag_opening = indented_synthetic_token(builder, "<%#", TOKEN_ERB_START, node_from);
  token_T* content = indented_source_token(builder, content_from, content_to, TOKEN_ERB_CONTENT);
  token_T* tag_closing = indented_synthetic_token(builder, "%>", TOKEN_ERB_END, content_to);

  return ast_erb_comment_node_init(
    tag_opening,
    content,
    tag_closing,
    indented_builder_position(builder, node_from),
    indented_builder_position(builder, content_to),
    NULL,
    builder->allocator
  );
}

AST_HTML_OPEN_TAG_NODE_T* indented_open_tag_node(indented_builder_T* builder, token_T* tag_name, uint32_t from) {
  token_T* tag_opening = indented_synthetic_token(builder, "<", TOKEN_HTML_TAG_START, from);
  position_T start = indented_builder_position(builder, from);

  return ast_html_open_tag_node_init(
    tag_opening,
    tag_name,
    NULL,
    hb_array_init(4, builder->allocator),
    false,
    start,
    tag_name ? tag_name->location.end : start,
    NULL,
    builder->allocator
  );
}

void indented_open_tag_append(
  indented_builder_T* builder,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  AST_NODE_T* child,
  uint32_t at
) {
  if (!child) { return; }

  hb_array_append(open_tag->children, indented_whitespace_node(builder, at));
  hb_array_append(open_tag->children, child);

  open_tag->base.location.end = child->location.end;
}

void indented_open_tag_finish(
  indented_builder_T* builder,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  const char* closing,
  uint32_t at,
  bool is_void
) {
  open_tag->tag_closing = indented_synthetic_token(
    builder,
    closing,
    strcmp(closing, "/>") == 0 ? TOKEN_HTML_TAG_SELF_CLOSE : TOKEN_HTML_TAG_END,
    at
  );
  open_tag->is_void = is_void;

  position_T end = indented_builder_position(builder, at);

  if (end.line > open_tag->base.location.end.line
      || (end.line == open_tag->base.location.end.line && end.column > open_tag->base.location.end.column)) {
    open_tag->base.location.end = end;
  }
}

AST_HTML_ELEMENT_NODE_T* indented_element_node(
  indented_builder_T* builder,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  hb_array_T* body,
  bool is_void,
  bool self_closing,
  uint32_t to
) {
  position_T end = indented_builder_position(builder, to);
  AST_NODE_T* close_tag = NULL;

  if (!is_void && !self_closing) {
    token_T* close_name = indented_owned_token(builder, open_tag->tag_name->value, TOKEN_IDENTIFIER, to, to);

    close_tag = (AST_NODE_T*) ast_html_close_tag_node_init(
      indented_synthetic_token(builder, "</", TOKEN_HTML_TAG_START_CLOSE, to),
      close_name,
      hb_array_init(0, builder->allocator),
      indented_synthetic_token(builder, ">", TOKEN_HTML_TAG_END, to),
      end,
      end,
      NULL,
      builder->allocator
    );
  }

  position_T start = open_tag->base.location.start;

  if (end.line < open_tag->base.location.end.line
      || (end.line == open_tag->base.location.end.line && end.column < open_tag->base.location.end.column)) {
    end = open_tag->base.location.end;
  }

  return ast_html_element_node_init(
    (AST_NODE_T*) open_tag,
    token_copy(open_tag->tag_name, builder->allocator),
    body ? body : hb_array_init(0, builder->allocator),
    close_tag,
    is_void || self_closing,
    builder->element_source,
    start,
    end,
    NULL,
    builder->allocator
  );
}

AST_HTML_ATTRIBUTE_NAME_NODE_T* indented_attribute_name_node(
  indented_builder_T* builder,
  hb_string_T name,
  uint32_t from,
  uint32_t to
) {
  position_T start = indented_builder_position(builder, from);
  position_T end = indented_builder_position(builder, to);

  hb_array_T* children = hb_array_init(1, builder->allocator);
  hb_array_append(children, ast_literal_node_init(name, start, end, NULL, builder->allocator));

  return ast_html_attribute_name_node_init(children, start, end, NULL, builder->allocator);
}

AST_HTML_ATTRIBUTE_NODE_T* indented_attribute_node(
  indented_builder_T* builder,
  AST_HTML_ATTRIBUTE_NAME_NODE_T* name,
  token_T* equals,
  token_T* open_quote,
  hb_array_T* value_children,
  token_T* close_quote,
  uint32_t from,
  uint32_t to
) {
  AST_HTML_ATTRIBUTE_VALUE_NODE_T* value = NULL;

  if (value_children) {
    position_T value_start = open_quote ? open_quote->location.start : indented_builder_position(builder, from);
    position_T value_end = close_quote ? close_quote->location.end : indented_builder_position(builder, to);

    value = ast_html_attribute_value_node_init(
      open_quote,
      value_children,
      close_quote,
      true,
      value_start,
      value_end,
      NULL,
      builder->allocator
    );
  }

  return ast_html_attribute_node_init(
    name,
    value ? equals : NULL,
    value,
    indented_builder_position(builder, from),
    indented_builder_position(builder, to),
    NULL,
    builder->allocator
  );
}

herb_ruby_program_T indented_builder_ruby_program(const indented_builder_T* builder) {
  return (herb_ruby_program_T) {
    .value = hb_buffer_value(&builder->ruby),
    .length = hb_buffer_length(&builder->ruby),
    .segments = builder->ruby_segments,
  };
}
