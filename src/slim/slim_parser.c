// Slim frontend.
//
// Parses a Slim template (https://github.com/slim-template/slim) into a Herb DocumentNode made of
// the regular HTML+ERB node types. The grammar mirrors Slim::Parser (slim 5.x) with the default
// options: `#`/`.` shortcuts, `()`/`[]`/`{}` attribute wrappers and `*` attribute splats.
//
// Mapping (see also docs in the Slim test suite):
//
//   tag / #id / .class           -> HTMLElementNode (element_source "Slim"), synthetic `</tag>` close tag
//   attr="x #{y}"                -> HTMLAttributeNode, value children LiteralNode + ERBContentNode (`<%=`)
//   attr=ruby / attr==ruby       -> HTMLAttributeNode with a `<%= ruby %>` / `<%== ruby %>` value
//   attr=true / attr=false|nil   -> boolean attribute / attribute omitted (like Slim does for literals)
//   .a.b class="c"               -> a single merged `class` attribute (Slim merges class values)
//   *splat                       -> ERBContentNode `<%= tag.attributes(**splat) %>` in the open tag (TODO)
//   | text, ' text, inline text  -> HTMLTextNode (+ ERBContentNode for `#{}` interpolation)
//   <inline html>                -> HTMLTextNode (+ interpolation), indented content follows as siblings
//   - code                       -> ERBContentNode `<% code %>` + indented content + synthetic `<% end %>`
//   = code / == code             -> ERBContentNode `<%= code %>` / `<%== code %>` (+ block content + `end`)
//   / comment                    -> ERBCommentNode `<%# comment %>`
//   /! comment                   -> HTMLCommentNode
//   doctype html                 -> HTMLDoctypeNode
//   javascript: / css:           -> <script> / <style> HTMLElementNode with LiteralNode body
//
// Slim does not emit any whitespace between tags, so no whitespace nodes are created for
// indentation or newlines. The only whitespace in the tree is the one Slim renders: the
// explicit `'`, `<`, `>` whitespace markers (HTMLTextNode " "), the newlines inside multi-line
// text blocks, and synthetic " " WhitespaceNodes between attributes inside open tags.

#include "../include/slim/slim_parser.h"
#include "../include/analyze/analyze.h"
#include "../include/ast/ast_nodes.h"
#include "../include/errors.h"
#include "../include/herb.h"
#include "../include/indented/indented_builder.h"
#include "../include/indented/indented_source.h"
#include "../include/indented/ruby_block.h"
#include "../include/lexer/token_struct.h"
#include "../include/lib/hb_allocator.h"
#include "../include/lib/hb_array.h"
#include "../include/lib/hb_buffer.h"
#include "../include/lib/hb_string.h"
#include "../include/parser/parser.h"
#include "../include/prism/herb_prism_node.h"
#include "../include/util/html_util.h"
#include "../include/visitor.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define SLIM_TAB_SIZE 4

typedef struct {
  indented_source_T source;
  indented_builder_T builder;
  const char* text;
  size_t line;
  uint32_t cursor;
  uint32_t limit;
  uint32_t last_end;
  hb_array_T* errors;
  const parser_options_T* options;
  hb_allocator_T* allocator;
  uint32_t dynamic_tag_count;
  bool uses_splat_helper;
} slim_parser_T;

typedef struct {
  indented_ruby_kind_T pending;
  bool closed_leading_continuation;
} slim_block_state_T;

typedef struct {
  hb_buffer_T buffer;
  bool has_span;
  uint32_t from;
  uint32_t to;
  bool literal;
  bool raw; // no `#{}` interpolation (embedded `ruby:` code)
  hb_array_T* output;
} slim_text_T;

typedef enum {
  SLIM_CLASS_SHORTCUT, // `.name`
  SLIM_CLASS_QUOTED,   // class="a #{b}"
  SLIM_CLASS_CODE,     // class=ruby
} slim_class_kind_T;

// One `class` value. Slim merges all of them into a single attribute (Temple::HTML::AttributeMerger),
// so they are collected while parsing the tag and emitted once the attributes are complete.
typedef struct {
  slim_class_kind_T kind;
  uint32_t name_from;
  uint32_t name_to;
  uint32_t from; // shortcut value, quoted content or Ruby code
  uint32_t to;
  token_T* equals;
  token_T* open_quote;
  token_T* close_quote;
  hb_array_T* children; // shortcut: [LiteralNode], quoted: unescaped LiteralNode + ERBContentNode
  bool raw;
} slim_class_part_T;

typedef enum {
  SLIM_SPEC_STATIC,  // `#id` shortcut
  SLIM_SPEC_QUOTED,  // attr="..." (children are already escaped unless raw)
  SLIM_SPEC_CODE,    // attr=ruby
  SLIM_SPEC_BOOLEAN, // (attr)
  SLIM_SPEC_SPLAT,   // *hash
} slim_spec_kind_T;

// Every attribute other than `class`, recorded so that a tag with a splat can be rebuilt with Slim's
// splat semantics (all attributes of such a tag go through Slim::Splat::Builder).
typedef struct {
  slim_spec_kind_T kind;
  hb_string_T name;
  uint32_t from; // value (or Ruby code) span
  uint32_t to;
  hb_array_T* children; // quoted value children
  bool raw;
} slim_attribute_spec_T;

typedef struct {
  hb_array_T* class_parts; // slim_class_part_T*
  size_t class_index;      // where the merged class attribute goes in the open tag's children
  hb_array_T* names;       // hb_string_T* of the other attribute names, to report duplicates
  hb_array_T* specs;       // slim_attribute_spec_T*
  bool splat;              // a `*splat` or a `data=`/`aria=` Ruby value (Slim's hyphen_attrs) was given
} slim_attributes_T;

static bool parse_block(slim_parser_T* parser, int64_t parent_indent, hb_array_T* output);
static void parse_tag(slim_parser_T* parser, hb_array_T* output, uint32_t indent);

// ---------------------------------------------------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------------------------------------------------

static const indented_line_T* current_line(const slim_parser_T* parser) {
  return parser->line < parser->source.line_count ? &parser->source.lines[parser->line] : NULL;
}

static uint32_t line_limit(const slim_parser_T* parser) {
  const indented_line_T* line = current_line(parser);
  if (!line) { return parser->cursor; }

  if (parser->limit > 0 && parser->limit < line->end) { return parser->limit; }

  return line->end;
}

static char char_at(const slim_parser_T* parser, uint32_t offset) {
  if (offset >= line_limit(parser)) { return '\0'; }

  return parser->text[offset];
}

static char peek(const slim_parser_T* parser) {
  return char_at(parser, parser->cursor);
}

static void skip_spaces(slim_parser_T* parser) {
  while (indented_is_space(peek(parser))) {
    parser->cursor++;
  }
}

static bool rest_is_blank(const slim_parser_T* parser) {
  for (uint32_t offset = parser->cursor; offset < line_limit(parser); offset++) {
    char character = parser->text[offset];
    if (!indented_is_space(character) && character != '\r') { return false; }
  }

  return true;
}

static void finish_line(slim_parser_T* parser) {
  const indented_line_T* line = current_line(parser);
  if (!line) { return; }

  if (!line->blank && line->content_end > parser->last_end) { parser->last_end = line->content_end; }

  parser->line++;

  const indented_line_T* next = current_line(parser);
  parser->cursor = next ? next->content_start : parser->source.length;
}

static int64_t next_nonblank_indent(const slim_parser_T* parser) {
  for (size_t index = parser->line; index < parser->source.line_count; index++) {
    if (!parser->source.lines[index].blank) { return parser->source.lines[index].indent; }
  }

  return -1;
}

static bool is_word_character(char character) {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9') || character == '_' || (unsigned char) character >= 0x80;
}

static bool starts_with(const slim_parser_T* parser, uint32_t offset, const char* prefix) {
  size_t length = strlen(prefix);

  if (offset + length > line_limit(parser)) { return false; }

  return strncmp(parser->text + offset, prefix, length) == 0;
}

static hb_string_T source_slice(const slim_parser_T* parser, uint32_t from, uint32_t to) {
  return hb_string_from_data(parser->text + from, to > from ? to - from : 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------

// Slim syntax errors are reported with the generic UnexpectedError ("<description>. Expected: <expected>,
// found: <found>."), where `found` is the source text between `from` and `to` (first line only).
static void syntax_error(
  slim_parser_T* parser,
  const char* description,
  const char* expected,
  uint32_t from,
  uint32_t to
) {
  hb_buffer_T found;
  hb_buffer_init(&found, 32, parser->allocator);

  uint32_t found_to = from;

  while (found_to < to && found_to < parser->source.length && parser->text[found_to] != '\n'
         && parser->text[found_to] != '\r') {
    found_to++;
  }

  if (found_to > from) {
    hb_buffer_append(&found, "`");
    hb_buffer_append_with_length(&found, parser->text + from, found_to - from);
    hb_buffer_append(&found, "`");
  } else {
    hb_buffer_append(&found, from >= parser->source.length ? "end of file" : "end of line");
  }

  append_unexpected_error(
    hb_string_from_c_string(description),
    hb_string_from_c_string(expected),
    hb_string_from_data(hb_buffer_value(&found), hb_buffer_length(&found)),
    indented_builder_position(&parser->builder, from),
    indented_builder_position(&parser->builder, to),
    parser->allocator,
    &parser->errors,
    parser->options
  );

  hb_buffer_free(&found);
}

static void indentation_error(
  slim_parser_T* parser,
  const char* description,
  const indented_line_T* line,
  uint32_t expected
) {
  char expected_message[64];
  char found_message[64];

  snprintf(expected_message, sizeof(expected_message), "an indentation of %u", expected);
  snprintf(found_message, sizeof(found_message), "an indentation of %u", line->indent);

  append_unexpected_error(
    hb_string_from_c_string(description),
    hb_string_from_c_string(expected_message),
    hb_string_from_c_string(found_message),
    indented_builder_position(&parser->builder, line->start),
    indented_builder_position(&parser->builder, line->content_start),
    parser->allocator,
    &parser->errors,
    parser->options
  );
}

// Content that cannot have indented children (closed tags, doctype, ...). Slim raises
// "Unexpected indentation"; we report it and keep parsing the lines as siblings.
static void check_unexpected_children(slim_parser_T* parser, uint32_t indent, hb_array_T* output) {
  if (next_nonblank_indent(parser) <= (int64_t) indent) { return; }

  size_t index = parser->line;
  while (index < parser->source.line_count && parser->source.lines[index].blank) {
    index++;
  }

  indentation_error(parser, "Unexpected indentation", &parser->source.lines[index], indent);
  parse_block(parser, indent, output);
}

// ---------------------------------------------------------------------------------------------------------------------
// Text and interpolation
// ---------------------------------------------------------------------------------------------------------------------

static void text_init(slim_parser_T* parser, slim_text_T* text, hb_array_T* output, bool literal) {
  hb_buffer_init(&text->buffer, 64, parser->allocator);
  text->has_span = false;
  text->from = 0;
  text->to = 0;
  text->literal = literal;
  text->raw = false;
  text->output = output;
}

static void text_extend(slim_text_T* text, uint32_t from, uint32_t to) {
  if (!text->has_span) {
    text->from = from;
    text->to = to;
    text->has_span = true;
    return;
  }

  if (from < text->from) { text->from = from; }
  if (to > text->to) { text->to = to; }
}

static void text_append_source(slim_parser_T* parser, slim_text_T* text, uint32_t from, uint32_t to) {
  if (to <= from) { return; }

  hb_buffer_append_with_length(&text->buffer, parser->text + from, to - from);
  text_extend(text, from, to);
}

static void text_append_synthetic(slim_text_T* text, const char* value, uint32_t at) {
  hb_buffer_append(&text->buffer, value);
  text_extend(text, at, at);
}

static void text_emit(slim_parser_T* parser, slim_text_T* text, hb_string_T content, uint32_t from, uint32_t to) {
  if (content.length == 0) { return; }

  AST_NODE_T* node = text->literal ? (AST_NODE_T*) indented_literal_node(&parser->builder, content, from, to)
                                   : (AST_NODE_T*) indented_text_node(&parser->builder, content, from, to);

  hb_array_append(text->output, node);
}

// Slim renders text verbatim, so a literal `<%` (or `%>`) must not turn into an ERB tag once the tree is printed
// as HTML+ERB. It is emitted as the ERB output `<%== "<" + "%" %>` (`<%== "%" + ">" %>`), which renders exactly
// `<%` in any context (including <script> and <style> bodies, where an HTML entity would not be decoded).
static void text_flush(slim_parser_T* parser, slim_text_T* text) {
  hb_string_T content = hb_string_from_data(hb_buffer_value(&text->buffer), hb_buffer_length(&text->buffer));
  uint32_t segment_start = 0;
  uint32_t from = text->from;

  for (uint32_t index = 0; index + 1 < content.length; index++) {
    bool opener = content.data[index] == '<' && content.data[index + 1] == '%';
    bool closer = content.data[index] == '%' && content.data[index + 1] == '>';
    if (!opener && !closer) { continue; }

    text_emit(parser, text, hb_string_from_data(content.data + segment_start, index - segment_start), from, text->to);
    hb_array_append(
      text->output,
      indented_synthetic_erb_node(&parser->builder, "<%==", opener ? " \"<\" + \"%\" " : " \"%\" + \">\" ", text->to)
    );

    segment_start = index + 2;
    from = text->to;
    index++;
  }

  text_emit(
    parser,
    text,
    hb_string_from_data(content.data + segment_start, content.length - segment_start),
    from,
    text->to
  );

  hb_buffer_clear(&text->buffer);
  text->has_span = false;
}

static void text_free(slim_text_T* text) {
  hb_buffer_free(&text->buffer);
}

static void append_space(slim_parser_T* parser, hb_array_T* output, uint32_t at) {
  hb_array_append(output, indented_text_node(&parser->builder, hb_string(" "), at, at));
}

static uint32_t find_interpolation_end(const slim_parser_T* parser, uint32_t from, uint32_t to) {
  uint32_t depth = 0;

  for (uint32_t offset = from; offset < to; offset++) {
    char character = parser->text[offset];

    if (character == '{') {
      depth++;
    } else if (character == '}') {
      if (depth == 0) { return offset; }
      depth--;
    }
  }

  return UINT32_MAX;
}

// Slim::Interpolation: `#{code}` is escaped output, `#{{code}}` is unescaped output, `\#{` is a literal `#{`.
static void interpolate(slim_parser_T* parser, slim_text_T* text, uint32_t from, uint32_t to) {
  if (text->raw) {
    text_append_source(parser, text, from, to);
    return;
  }

  uint32_t offset = from;
  uint32_t static_from = from;

  while (offset < to) {
    char character = parser->text[offset];

    if (character == '\\' && offset + 2 < to && parser->text[offset + 1] == '#' && parser->text[offset + 2] == '{') {
      text_append_source(parser, text, static_from, offset);
      text_append_source(parser, text, offset + 1, offset + 3);
      offset += 3;
      static_from = offset;
      continue;
    }

    if (character == '#' && offset + 1 < to && parser->text[offset + 1] == '{') {
      uint32_t close = find_interpolation_end(parser, offset + 2, to);

      if (close != UINT32_MAX) {
        text_append_source(parser, text, static_from, offset);
        text_flush(parser, text);

        uint32_t code_from = offset + 2;
        uint32_t code_to = close;
        bool raw = false;

        if (code_to - code_from >= 2 && parser->text[code_from] == '{' && parser->text[code_to - 1] == '}') {
          raw = true;
          code_from++;
          code_to--;
        }

        if (code_to > code_from) {
          hb_array_append(
            text->output,
            indented_erb_node(&parser->builder, raw ? "<%==" : "<%=", offset, code_from, code_to, NULL, NULL)
          );
        }

        offset = close + 1;
        static_from = offset;
        continue;
      }
    }

    offset++;
  }

  text_append_source(parser, text, static_from, to);
}

// Slim::Parser#parse_text_block: the rest of the current line (starting at `first_from`) plus every following
// line indented deeper than `owner_indent`. Lines are joined with "\n", keeping their indentation relative to
// the first text line. Consumes the lines it reads.
static void parse_text_block(
  slim_parser_T* parser,
  slim_text_T* text,
  uint32_t first_from,
  int64_t text_indent,
  uint32_t owner_indent
) {
  const indented_line_T* line = current_line(parser);
  int64_t indent = -1;

  if (line && first_from < line->end) {
    interpolate(parser, text, first_from, line->end);
    indent = text_indent;
  }

  finish_line(parser);

  uint32_t empty_lines = 0;

  while ((line = current_line(parser))) {
    if (line->blank) {
      finish_line(parser);
      if (indent >= 0) { empty_lines++; }
      continue;
    }

    if (line->indent <= owner_indent) { break; }

    for (; empty_lines > 0; empty_lines--) {
      text_append_synthetic(text, "\n", line->start);
    }

    int64_t offset = indent >= 0 ? (int64_t) line->indent - indent : 0;

    if (offset < 0) {
      indent += offset;
      offset = 0;
    }

    if (indent >= 0) { text_append_synthetic(text, "\n", line->content_start); }

    for (int64_t space = 0; space < offset; space++) {
      text_append_synthetic(text, " ", line->content_start);
    }

    interpolate(parser, text, line->content_start, line->end);

    if (indent < 0) { indent = line->indent; }

    finish_line(parser);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ruby code and implicit `end`s
// ---------------------------------------------------------------------------------------------------------------------

static void close_pending(slim_parser_T* parser, hb_array_T* output, slim_block_state_T* state) {
  if (state->pending == INDENTED_RUBY_OPENS_END) {
    hb_array_append(output, indented_synthetic_erb_node(&parser->builder, "<%", " end ", parser->last_end));
  } else if (state->pending == INDENTED_RUBY_OPENS_BRACE) {
    hb_array_append(output, indented_synthetic_erb_node(&parser->builder, "<%", " } ", parser->last_end));
  }

  state->pending = INDENTED_RUBY_STATEMENT;
}

// Slim::Parser#parse_broken_line: the rest of the line, continued on the next lines while it ends with `,` or `\`.
static void parse_broken_line(slim_parser_T* parser, uint32_t* code_from, uint32_t* code_to) {
  skip_spaces(parser);

  const indented_line_T* line = current_line(parser);
  *code_from = parser->cursor;

  uint32_t end = line ? line->content_end : parser->cursor;
  if (end < *code_from) { end = *code_from; }

  finish_line(parser);

  while (end > *code_from && (parser->text[end - 1] == ',' || parser->text[end - 1] == '\\')) {
    line = current_line(parser);

    if (!line) {
      syntax_error(parser, "Unexpected end of file", "a continuation line", end, end);
      break;
    }

    finish_line(parser);

    if (line->blank) { break; }

    end = line->content_end;
  }

  *code_to = end;
}

// Whether the lines indented deeper than `indent` contain anything but Slim comments (`/ ...`), which render
// nothing: Slim only adds an implicit `do` when a code line has non-empty content.
static bool has_content_children(const slim_parser_T* parser, uint32_t indent) {
  int64_t block_indent = -1;

  for (size_t index = parser->line; index < parser->source.line_count; index++) {
    const indented_line_T* line = &parser->source.lines[index];
    if (line->blank) { continue; }
    if (line->indent <= indent) { break; }

    if (block_indent < 0) { block_indent = line->indent; }
    if ((int64_t) line->indent != block_indent) { continue; }

    const char* content = parser->text + line->content_start;
    bool slim_comment =
      content[0] == '/' && (line->content_end - line->content_start < 2 || (content[1] != '!' && content[1] != '['));

    if (!slim_comment) { return true; }
  }

  return false;
}

static indented_ruby_kind_T classify(const slim_parser_T* parser, uint32_t from, uint32_t to) {
  return indented_ruby_classify(parser->text + from, to - from);
}

// Output code (`= code`, `== code`, `p = code`), including the indented block content of `= helper do |x|`.
static void parse_output_code(slim_parser_T* parser, hb_array_T* output, uint32_t start, bool raw, uint32_t indent) {
  uint32_t code_from = 0;
  uint32_t code_to = 0;
  parse_broken_line(parser, &code_from, &code_to);

  if (code_to <= code_from) {
    syntax_error(parser, "Missing Ruby code", "Ruby code after `=`", code_to, code_to);
    check_unexpected_children(parser, indent, output);
    return;
  }

  indented_ruby_kind_T kind = classify(parser, code_from, code_to);
  bool has_children = has_content_children(parser, indent);
  const char* suffix = NULL;

  // Slim::DoInserter: `= helper` followed by indented content gets an implicit `do`.
  if (kind == INDENTED_RUBY_STATEMENT && has_children) {
    suffix = " do";
    kind = INDENTED_RUBY_OPENS_END;
  }

  hb_array_append(
    output,
    indented_erb_node(&parser->builder, raw ? "<%==" : "<%=", start, code_from, code_to, suffix, NULL)
  );

  parse_block(parser, indent, output);

  slim_block_state_T state = { .pending = kind, .closed_leading_continuation = false };
  close_pending(parser, output, &state);
}

// Control code (`- code`). Blocks are closed with a synthetic `<% end %>` once the next sibling that doesn't
// continue the construct (`else`, `elsif`, `when`, `in`, `rescue`, `ensure`) shows up, like Slim::EndInserter.
static void parse_control(slim_parser_T* parser, hb_array_T* output, slim_block_state_T* state, uint32_t indent) {
  uint32_t start = parser->cursor;
  parser->cursor++;

  uint32_t code_from = 0;
  uint32_t code_to = 0;
  parse_broken_line(parser, &code_from, &code_to);

  indented_ruby_kind_T kind = classify(parser, code_from, code_to);
  bool has_children = has_content_children(parser, indent);
  bool continues_opener = kind == INDENTED_RUBY_CONTINUATION && state->pending != INDENTED_RUBY_STATEMENT;
  const char* suffix = NULL;

  if (kind == INDENTED_RUBY_END) {
    syntax_error(
      parser,
      "Explicit end statements are forbidden",
      "the block to be closed by indentation",
      start,
      code_to
    );
    state->pending = INDENTED_RUBY_STATEMENT;
  } else if (kind == INDENTED_RUBY_CLOSE_BRACE && state->pending == INDENTED_RUBY_OPENS_BRACE) {
    // Slim never implies a `}`: an explicit `- }` closes the pending brace block.
    state->pending = INDENTED_RUBY_STATEMENT;
  } else if (!continues_opener) {
    close_pending(parser, output, state);
  }

  // Slim::DoInserter: `- 3.times` followed by indented content gets an implicit `do`.
  if (kind == INDENTED_RUBY_STATEMENT && has_children && code_to > code_from) {
    suffix = " do";
    kind = INDENTED_RUBY_OPENS_END;
  }

  if (code_to > code_from) {
    hb_array_append(output, indented_erb_node(&parser->builder, "<%", start, code_from, code_to, suffix, NULL));
  }

  bool closed_leading_continuation = parse_block(parser, indent, output);

  switch (kind) {
    case INDENTED_RUBY_OPENS_END:
      // `- case x` followed by indented `- when` branches: the branches already closed the construct.
      state->pending = closed_leading_continuation ? INDENTED_RUBY_STATEMENT : INDENTED_RUBY_OPENS_END;
      break;

    case INDENTED_RUBY_OPENS_BRACE: state->pending = INDENTED_RUBY_OPENS_BRACE; break;

    case INDENTED_RUBY_CONTINUATION:
      if (!continues_opener) {
        state->pending = INDENTED_RUBY_OPENS_END;
        state->closed_leading_continuation = true;
      }
      break;

    default: state->pending = INDENTED_RUBY_STATEMENT; break;
  }
}

static void parse_line_output(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  uint32_t start = parser->cursor;
  parser->cursor++;

  bool raw = false;

  if (peek(parser) == '=') {
    raw = true;
    parser->cursor++;
  }

  bool leading_whitespace = false;
  bool trailing_whitespace = false;

  for (char character = peek(parser); character == '<' || character == '>'; character = peek(parser)) {
    if (character == '<') { leading_whitespace = true; }
    if (character == '>') { trailing_whitespace = true; }
    parser->cursor++;
  }

  if (leading_whitespace) { append_space(parser, output, start); }

  parse_output_code(parser, output, start, raw, indent);

  if (trailing_whitespace) { append_space(parser, output, parser->last_end); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------------------------------------------------

static bool is_attribute_name_character(char character) {
  if (character == '\0' || indented_is_space(character) || character == '\r' || character == '\n') { return false; }

  return strchr("\"'></=()[]{}", character) == NULL;
}

static char closing_delimiter(char character) {
  switch (character) {
    case '(': return ')';
    case '[': return ']';
    case '{': return '}';
    default: return '\0';
  }
}

// Slim::Parser#parse_ruby_code: Ruby code up to the next whitespace (or the closing attribute delimiter),
// respecting nested (), [] and {} and continuing on the next line after a trailing `,` or `\`.
static uint32_t parse_ruby_code(slim_parser_T* parser, char outer_delimiter) {
  uint32_t code_to = parser->cursor;
  uint32_t count = 0;
  char open = '\0';
  char close = '\0';

  while (current_line(parser)) {
    uint32_t limit = line_limit(parser);
    if (parser->cursor >= limit) { break; }

    char character = parser->text[parser->cursor];

    if (count == 0 && (indented_is_space(character) || (outer_delimiter && character == outer_delimiter))) { break; }

    if ((character == ',' || character == '\\') && parser->cursor + 1 >= limit) {
      parser->cursor++;
      code_to = parser->cursor;
      finish_line(parser);

      if (!current_line(parser)) {
        syntax_error(parser, "Unexpected end of file", "a continuation line", code_to, code_to);
        break;
      }

      continue;
    }

    if (count > 0) {
      if (character == open) {
        count++;
      } else if (character == close) {
        count--;
      }
    } else if (closing_delimiter(character)) {
      count = 1;
      open = character;
      close = closing_delimiter(character);
    }

    parser->cursor++;
    code_to = parser->cursor;
  }

  if (count != 0) {
    char message[64];
    snprintf(message, sizeof(message), "`%c`", close);
    syntax_error(parser, "Unclosed delimiter in Ruby attribute value", message, code_to, code_to);
  }

  return code_to;
}

static bool is_class_attribute(hb_string_T name) {
  return hb_string_equals(name, hb_string("class"));
}

static void attributes_init(slim_parser_T* parser, slim_attributes_T* attributes) {
  attributes->class_parts = hb_array_init(2, parser->allocator);
  attributes->class_index = 0;
  attributes->names = hb_array_init(4, parser->allocator);
  attributes->specs = hb_array_init(4, parser->allocator);
  attributes->splat = false;
}

static void record_spec(
  slim_parser_T* parser,
  slim_attributes_T* attributes,
  slim_spec_kind_T kind,
  hb_string_T name,
  uint32_t from,
  uint32_t to,
  hb_array_T* children,
  bool raw
) {
  slim_attribute_spec_T* spec = hb_allocator_alloc(parser->allocator, sizeof(slim_attribute_spec_T));
  *spec =
    (slim_attribute_spec_T) { .kind = kind, .name = name, .from = from, .to = to, .children = children, .raw = raw };

  hb_array_append(attributes->specs, spec);

  if (kind == SLIM_SPEC_SPLAT) { attributes->splat = true; }

  if (kind == SLIM_SPEC_CODE
      && (hb_string_equals(name, hb_string("data")) || hb_string_equals(name, hb_string("aria")))) {
    attributes->splat = true;
  }
}

static void attributes_free(slim_parser_T* parser, slim_attributes_T* attributes) {
  for (size_t index = 0; index < hb_array_size(attributes->class_parts); index++) {
    hb_allocator_dealloc(parser->allocator, hb_array_get(attributes->class_parts, index));
  }

  for (size_t index = 0; index < hb_array_size(attributes->names); index++) {
    hb_allocator_dealloc(parser->allocator, hb_array_get(attributes->names, index));
  }

  for (size_t index = 0; index < hb_array_size(attributes->specs); index++) {
    hb_allocator_dealloc(parser->allocator, hb_array_get(attributes->specs, index));
  }

  hb_array_free(&attributes->class_parts);
  hb_array_free(&attributes->names);
  hb_array_free(&attributes->specs);
}

// Slim (Temple::HTML::AttributeMerger) only allows `class` to be given more than once.
static void note_attribute_name(
  slim_parser_T* parser,
  slim_attributes_T* attributes,
  hb_string_T name,
  uint32_t from,
  uint32_t to
) {
  for (size_t index = 0; index < hb_array_size(attributes->names); index++) {
    hb_string_T* existing = hb_array_get(attributes->names, index);

    if (hb_string_equals(*existing, name)) {
      syntax_error(parser, "Duplicate attribute", "every attribute other than `class` at most once", from, to);
      return;
    }
  }

  hb_string_T* stored = hb_allocator_alloc(parser->allocator, sizeof(hb_string_T));
  *stored = name;
  hb_array_append(attributes->names, stored);
}

static void append_attribute_node(
  slim_parser_T* parser,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  hb_string_T name,
  uint32_t name_from,
  uint32_t name_to,
  token_T* equals,
  token_T* open_quote,
  hb_array_T* value_children,
  token_T* close_quote,
  uint32_t to
) {
  AST_HTML_ATTRIBUTE_NAME_NODE_T* name_node = indented_attribute_name_node(&parser->builder, name, name_from, name_to);

  AST_HTML_ATTRIBUTE_NODE_T* attribute = indented_attribute_node(
    &parser->builder,
    name_node,
    equals,
    open_quote,
    value_children,
    close_quote,
    name_from,
    to
  );

  indented_open_tag_append(&parser->builder, open_tag, (AST_NODE_T*) attribute, name_from);
}

// Temple::Utils.escape_html, applied by Slim to the static text of `attr="..."` (but not `attr=="..."`).
static void escape_literal_children(slim_parser_T* parser, hb_array_T* children) {
  for (size_t index = 0; index < hb_array_size(children); index++) {
    AST_NODE_T* child = hb_array_get(children, index);
    if (child->type != AST_LITERAL_NODE) { continue; }

    AST_LITERAL_NODE_T* literal = (AST_LITERAL_NODE_T*) child;
    hb_buffer_T escaped;
    hb_buffer_init(&escaped, literal->content.length + 16, parser->allocator);

    for (uint32_t offset = 0; offset < literal->content.length; offset++) {
      switch (literal->content.data[offset]) {
        case '&': hb_buffer_append(&escaped, "&amp;"); break;
        case '<': hb_buffer_append(&escaped, "&lt;"); break;
        case '>': hb_buffer_append(&escaped, "&gt;"); break;
        case '"': hb_buffer_append(&escaped, "&quot;"); break;
        case '\'': hb_buffer_append(&escaped, "&#39;"); break;
        default: hb_buffer_append_char(&escaped, literal->content.data[offset]); break;
      }
    }

    if (hb_buffer_length(&escaped) != literal->content.length) {
      if (!hb_string_is_empty(literal->content)) { hb_allocator_dealloc(parser->allocator, literal->content.data); }

      literal->content =
        hb_string_copy(hb_string_from_data(hb_buffer_value(&escaped), hb_buffer_length(&escaped)), parser->allocator);
    }

    hb_buffer_free(&escaped);
  }
}

// Code that can be evaluated more than once without side effects: instance/class variables and literals.
// A bare identifier may be a method call, so it is evaluated once into a temporary variable instead.
static bool is_simple_reference(hb_string_T code) {
  if (code.length == 0) { return false; }

  uint32_t offset = 0;

  if (code.data[0] == '@') {
    offset = code.length > 1 && code.data[1] == '@' ? 2 : 1;
    if (offset >= code.length) { return false; }

    char first = code.data[offset];
    if (!((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || first == '_')) { return false; }
  } else if (code.data[0] == ':') {
    offset = 1;
    if (offset >= code.length) { return false; }
  } else if (code.data[0] >= '0' && code.data[0] <= '9') {
    for (; offset < code.length; offset++) {
      if (!((code.data[offset] >= '0' && code.data[offset] <= '9') || code.data[offset] == '.'
            || code.data[offset] == '_')) {
        return false;
      }
    }

    return true;
  } else {
    return false;
  }

  for (; offset < code.length; offset++) {
    char character = code.data[offset];

    if (!((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
          || (character >= '0' && character <= '9') || character == '_')) {
      return false;
    }
  }

  return true;
}

// A Ruby value inside the class Array literal. Wrapping it in `[...]` keeps comma lists
// (`class=:a,:b`) valid; `flatten` removes the extra level.
static void append_ruby_code(hb_buffer_T* buffer, hb_string_T code) {
  if (is_simple_reference(code)) {
    hb_buffer_append_string(buffer, code);
    return;
  }

  hb_buffer_append_char(buffer, '[');
  hb_buffer_append_string(buffer, code);
  hb_buffer_append_char(buffer, ']');
}

static void append_ruby_string_content(hb_buffer_T* buffer, hb_string_T text) {
  for (uint32_t offset = 0; offset < text.length; offset++) {
    char character = text.data[offset];

    switch (character) {
      case '"': hb_buffer_append(buffer, "\\\""); break;
      case '\\': hb_buffer_append(buffer, "\\\\"); break;
      case '#': hb_buffer_append(buffer, "\\#"); break;
      case '\n': hb_buffer_append(buffer, "\\n"); break;
      default: hb_buffer_append_char(buffer, character); break;
    }
  }
}

static bool class_part_has_static(const slim_class_part_T* part) {
  if (part->kind == SLIM_CLASS_CODE) { return false; }

  for (size_t index = 0; index < hb_array_size(part->children); index++) {
    AST_NODE_T* child = hb_array_get(part->children, index);

    if (child->type == AST_LITERAL_NODE && ((AST_LITERAL_NODE_T*) child)->content.length > 0) { return true; }
  }

  return false;
}

static void append_class_part_ruby(slim_parser_T* parser, hb_buffer_T* buffer, const slim_class_part_T* part) {
  if (part->kind == SLIM_CLASS_CODE) {
    append_ruby_code(buffer, source_slice(parser, part->from, part->to));
    return;
  }

  hb_buffer_append_char(buffer, '"');

  for (size_t index = 0; index < hb_array_size(part->children); index++) {
    AST_NODE_T* child = hb_array_get(part->children, index);

    if (child->type == AST_LITERAL_NODE) {
      append_ruby_string_content(buffer, ((AST_LITERAL_NODE_T*) child)->content);
    } else if (child->type == AST_ERB_CONTENT_NODE) {
      hb_buffer_append(buffer, "#{");
      hb_buffer_append_string(buffer, ((AST_ERB_CONTENT_NODE_T*) child)->content->value);
      hb_buffer_append(buffer, "}");
    }
  }

  hb_buffer_append_char(buffer, '"');
}

static void free_class_part_nodes(slim_parser_T* parser, slim_class_part_T* part) {
  if (part->children) {
    for (size_t index = 0; index < hb_array_size(part->children); index++) {
      ast_node_free(hb_array_get(part->children, index), parser->allocator);
    }

    hb_array_free(&part->children);
  }

  if (part->equals) { token_free(part->equals, parser->allocator); }
  if (part->open_quote) { token_free(part->open_quote, parser->allocator); }
  if (part->close_quote) { token_free(part->close_quote, parser->allocator); }

  part->equals = part->open_quote = part->close_quote = NULL;
}

// Emits the merged `class` attribute (Temple::HTML::AttributeMerger + Slim::CodeAttributes + AttributeRemover):
//
//   - every value has static text:  class="a b#{c}"         (values joined with " ", like Slim)
//   - some value is Ruby:           class="<%= ["a", b].flatten.map(&:to_s).reject(&:empty?).join(" ") %>"
//     (Arrays are flattened and joined, empty values dropped), and when nothing static guarantees a
//     non-empty value, the attribute is omitted when empty, like Slim does:
//                                   <% unless (_slim_class = [...]...join(" ")).empty? %>class="<%= _slim_class %>"<%
//                                   end %>
static void emit_class_attribute(
  slim_parser_T* parser,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  slim_attributes_T* attributes
) {
  size_t count = hb_array_size(attributes->class_parts);
  if (count == 0) { return; }

  hb_array_T* nodes = hb_array_init(4, parser->allocator);
  bool conditional = false;
  slim_class_part_T* first = hb_array_get(attributes->class_parts, 0);
  slim_class_part_T* last = hb_array_last(attributes->class_parts);

  bool all_static = true;
  bool any_static = false;
  bool all_raw = true;

  for (size_t index = 0; index < count; index++) {
    slim_class_part_T* part = hb_array_get(attributes->class_parts, index);
    bool has_static = class_part_has_static(part);

    all_static = all_static && has_static;
    any_static = any_static || has_static;
    if (part->kind != SLIM_CLASS_SHORTCUT && !part->raw) { all_raw = false; }
  }

  if (all_static && count == 1 && first->kind == SLIM_CLASS_QUOTED) {
    if (!first->raw) { escape_literal_children(parser, first->children); }

    AST_HTML_ATTRIBUTE_NODE_T* attribute = indented_attribute_node(
      &parser->builder,
      indented_attribute_name_node(&parser->builder, hb_string("class"), first->name_from, first->name_to),
      first->equals,
      first->open_quote,
      first->children,
      first->close_quote,
      first->name_from,
      first->to + 1
    );

    hb_array_append(nodes, attribute);
  } else if (all_static) {
    hb_array_T* children = hb_array_init(count * 2, parser->allocator);

    for (size_t index = 0; index < count; index++) {
      slim_class_part_T* part = hb_array_get(attributes->class_parts, index);

      if (index > 0) {
        hb_array_append(children, indented_literal_node(&parser->builder, hb_string(" "), part->from, part->from));
      }
      if (part->kind == SLIM_CLASS_QUOTED && !part->raw) { escape_literal_children(parser, part->children); }

      for (size_t child = 0; child < hb_array_size(part->children); child++) {
        hb_array_append(children, hb_array_get(part->children, child));
      }

      hb_array_free(&part->children);
      free_class_part_nodes(parser, part);
    }

    hb_array_append(
      nodes,
      indented_attribute_node(
        &parser->builder,
        indented_attribute_name_node(&parser->builder, hb_string("class"), first->name_from, first->name_to),
        indented_synthetic_token(&parser->builder, "=", TOKEN_EQUALS, first->from),
        indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, first->from),
        children,
        indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, last->to),
        first->name_from,
        last->to
      )
    );
  } else {
    hb_buffer_T expression;
    hb_buffer_init(&expression, 128, parser->allocator);
    hb_buffer_append(&expression, "[");

    for (size_t index = 0; index < count; index++) {
      slim_class_part_T* part = hb_array_get(attributes->class_parts, index);

      if (index > 0) { hb_buffer_append(&expression, ", "); }
      append_class_part_ruby(parser, &expression, part);
      free_class_part_nodes(parser, part);
    }

    hb_buffer_append(&expression, "].flatten.map(&:to_s).reject(&:empty?).join(\" \")");

    const char* opening = all_raw ? "<%==" : "<%=";
    hb_buffer_T content;
    hb_buffer_init(&content, hb_buffer_length(&expression) + 64, parser->allocator);

    if (any_static) {
      hb_buffer_append(&content, " ");
      hb_buffer_append(&content, hb_buffer_value(&expression));
      hb_buffer_append(&content, " ");

      hb_array_T* children = hb_array_init(1, parser->allocator);
      hb_array_append(
        children,
        indented_erb_node(
          &parser->builder,
          opening,
          first->from,
          first->from,
          last->to,
          NULL,
          hb_buffer_value(&content)
        )
      );

      hb_array_append(
        nodes,
        indented_attribute_node(
          &parser->builder,
          indented_attribute_name_node(&parser->builder, hb_string("class"), first->name_from, first->name_to),
          indented_synthetic_token(&parser->builder, "=", TOKEN_EQUALS, first->from),
          indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, first->from),
          children,
          indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, last->to),
          first->name_from,
          last->to
        )
      );
    } else {
      hb_buffer_append(&content, " unless (_slim_class = ");
      hb_buffer_append(&content, hb_buffer_value(&expression));
      hb_buffer_append(&content, ").empty? ");

      hb_array_append(
        nodes,
        indented_erb_node(&parser->builder, "<%", first->from, first->from, last->to, NULL, hb_buffer_value(&content))
      );
      hb_array_append(nodes, indented_whitespace_node(&parser->builder, first->name_from));
      conditional = true;

      hb_array_T* children = hb_array_init(1, parser->allocator);
      hb_array_append(children, indented_synthetic_erb_node(&parser->builder, opening, " _slim_class ", last->to));

      hb_array_append(
        nodes,
        indented_attribute_node(
          &parser->builder,
          indented_attribute_name_node(&parser->builder, hb_string("class"), first->name_from, first->name_to),
          indented_synthetic_token(&parser->builder, "=", TOKEN_EQUALS, last->to),
          indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, last->to),
          children,
          indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, last->to),
          first->name_from,
          last->to
        )
      );

      hb_array_append(nodes, indented_synthetic_erb_node(&parser->builder, "<%", " end ", last->to));
    }

    hb_buffer_free(&content);
    hb_buffer_free(&expression);
  }

  // Insert the nodes where the first class value appeared, preceded by a whitespace node (inside the
  // condition when the attribute can be omitted).
  hb_array_T* children = hb_array_init(hb_array_size(open_tag->children) + hb_array_size(nodes) + 1, parser->allocator);
  size_t insert_at = attributes->class_index;

  for (size_t index = 0; index <= hb_array_size(open_tag->children); index++) {
    if (index == insert_at) {
      if (!conditional) { hb_array_append(children, indented_whitespace_node(&parser->builder, first->name_from)); }

      for (size_t node = 0; node < hb_array_size(nodes); node++) {
        hb_array_append(children, hb_array_get(nodes, node));
      }
    }

    if (index < hb_array_size(open_tag->children)) {
      hb_array_append(children, hb_array_get(open_tag->children, index));
    }
  }

  hb_array_free(&open_tag->children);
  hb_array_free(&nodes);
  open_tag->children = children;
}

static void add_class_part(
  slim_parser_T* parser,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  slim_attributes_T* attributes,
  slim_class_part_T part
) {
  if (hb_array_size(attributes->class_parts) == 0) { attributes->class_index = hb_array_size(open_tag->children); }

  slim_class_part_T* stored = hb_allocator_alloc(parser->allocator, sizeof(slim_class_part_T));
  *stored = part;
  hb_array_append(attributes->class_parts, stored);
}

// Slim::Splat::Builder (with Slim's defaults: merge_attrs class, hyphen_attrs data/aria, sort_attrs, html
// format), written in plain Ruby so the printed ERB renders the same without Rails or the slim gem. It is
// defined once at the top of a document that uses splats or dynamic tags.
static const char* SLIM_SPLAT_HELPER =
  " _slim_escape = lambda do |value|\n"
  "  if value.respond_to?(:html_safe?) && value.html_safe?\n"
  "    value.to_s\n"
  "  else\n"
  "    value.to_s.gsub(/[&<>\"']/, \"&\" => \"&amp;\", \"<\" => \"&lt;\", \">\" => \"&gt;\", '\"' => \"&quot;\", \"'\" "
  "=> "
  "\"&#39;\")\n"
  "  end\n"
  "end\n"
  "_slim_splat = lambda do |entries, dynamic_tag = false|\n"
  "  attributes = {}\n"
  "  add = lambda do |name, value|\n"
  "    if !attributes.key?(name)\n"
  "      attributes[name] = value\n"
  "    elsif name == \"class\"\n"
  "      attributes[name] = \"#{attributes[name]} #{value}\"\n"
  "    else\n"
  "      raise ArgumentError, \"Multiple #{name} attributes specified\"\n"
  "    end\n"
  "  end\n"
  "  escape = ->(value, escaped) { escaped && value != true ? _slim_escape.(value) : value }\n"
  "  hyphen = lambda do |name, value, escaped|\n"
  "    if value.is_a?(Hash)\n"
  "      value.each { |key, nested| hyphen.(\"#{name}-#{key}\", nested, escaped) }\n"
  "    else\n"
  "      add.(name, escape.(value, escaped))\n"
  "    end\n"
  "  end\n"
  "  code = lambda do |name, value, escaped|\n"
  "    if name == \"class\"\n"
  "      value = value.is_a?(Array) ? value.join(\" \") : value.to_s\n"
  "      add.(name, escape.(value, escaped)) unless value.empty?\n"
  "    elsif (name == \"data\" || name == \"aria\") && value.is_a?(Hash)\n"
  "      hyphen.(name, value, escaped)\n"
  "    elsif value != false && !value.nil?\n"
  "      add.(name, escape.(value, escaped))\n"
  "    end\n"
  "  end\n"
  "  entries.each do |kind, *arguments|\n"
  "    case kind\n"
  "    when :attr then add.(*arguments)\n"
  "    when :code then code.(*arguments)\n"
  "    else arguments.first.each { |name, value| code.(name.to_s, value, true) }\n"
  "    end\n"
  "  end\n"
  "  tag = dynamic_tag && attributes.delete(\"tag\").to_s\n"
  "  html = attributes.sort_by(&:first).map { |name, value| value == true ? \" #{name}\" : \" "
  "#{name}=\\\"#{value}\\\"\" "
  "}.join\n"
  "  dynamic_tag ? [tag.empty? ? \"div\" : tag, html] : html\n"
  "end\n";

static void append_html_escaped_ruby_text(hb_buffer_T* buffer, hb_string_T text, bool html_escape) {
  for (uint32_t offset = 0; offset < text.length; offset++) {
    char character = text.data[offset];
    const char* entity = NULL;

    if (html_escape) {
      switch (character) {
        case '&': entity = "&amp;"; break;
        case '<': entity = "&lt;"; break;
        case '>': entity = "&gt;"; break;
        case '"': entity = "&quot;"; break;
        case '\'': entity = "&#39;"; break;
        default: break;
      }
    }

    if (entity) {
      append_ruby_string_content(buffer, hb_string_from_c_string(entity));
    } else {
      append_ruby_string_content(buffer, hb_string_from_data(text.data + offset, 1));
    }
  }
}

// A quoted attribute value as a Ruby string, the way Slim captures it: static text escaped (unless `==`
// or already escaped) and `#{}` interpolation escaped (unless `#{{}}`).
static void append_quoted_value_ruby(hb_buffer_T* buffer, hb_array_T* children, bool escape_static) {
  hb_buffer_append_char(buffer, '"');

  for (size_t index = 0; index < hb_array_size(children); index++) {
    AST_NODE_T* child = hb_array_get(children, index);

    if (child->type == AST_LITERAL_NODE) {
      append_html_escaped_ruby_text(buffer, ((AST_LITERAL_NODE_T*) child)->content, escape_static);
    } else if (child->type == AST_ERB_CONTENT_NODE) {
      AST_ERB_CONTENT_NODE_T* erb = (AST_ERB_CONTENT_NODE_T*) child;
      bool raw = hb_string_equals(erb->tag_opening->value, hb_string("<%=="));

      hb_buffer_append(buffer, raw ? "#{" : "#{_slim_escape.(");
      hb_buffer_append_string(buffer, erb->content->value);
      hb_buffer_append(buffer, raw ? "}" : ")}");
    }
  }

  hb_buffer_append_char(buffer, '"');
}

static void append_ruby_name(hb_buffer_T* buffer, hb_string_T name) {
  hb_buffer_append_char(buffer, '"');
  append_ruby_string_content(buffer, name);
  hb_buffer_append_char(buffer, '"');
}

static void append_code_entry(
  slim_parser_T* parser,
  hb_buffer_T* buffer,
  hb_string_T name,
  uint32_t from,
  uint32_t to,
  bool raw
) {
  hb_buffer_append(buffer, "[:code, ");
  append_ruby_name(buffer, name);
  hb_buffer_append(buffer, ", (");
  hb_buffer_append_string(buffer, source_slice(parser, from, to));
  hb_buffer_append(buffer, raw ? "), false]" : "), true]");
}

// The entries passed to `_slim_splat`: class values first (they only merge with each other), then the other
// attributes in source order.
static void build_splat_entries(slim_parser_T* parser, slim_attributes_T* attributes, hb_buffer_T* buffer) {
  bool first = true;
  hb_buffer_append(buffer, "[");

  for (size_t index = 0; index < hb_array_size(attributes->class_parts); index++) {
    slim_class_part_T* part = hb_array_get(attributes->class_parts, index);

    if (!first) { hb_buffer_append(buffer, ", "); }
    first = false;

    if (part->kind == SLIM_CLASS_CODE) {
      append_code_entry(parser, buffer, hb_string("class"), part->from, part->to, part->raw);
    } else {
      hb_buffer_append(buffer, "[:attr, \"class\", ");
      append_quoted_value_ruby(buffer, part->children, part->kind == SLIM_CLASS_QUOTED && !part->raw);
      hb_buffer_append(buffer, "]");
    }
  }

  for (size_t index = 0; index < hb_array_size(attributes->specs); index++) {
    slim_attribute_spec_T* spec = hb_array_get(attributes->specs, index);

    if (!first) { hb_buffer_append(buffer, ", "); }
    first = false;

    switch (spec->kind) {
      case SLIM_SPEC_STATIC:
        hb_buffer_append(buffer, "[:attr, ");
        append_ruby_name(buffer, spec->name);
        hb_buffer_append(buffer, ", ");
        append_ruby_name(buffer, source_slice(parser, spec->from, spec->to));
        hb_buffer_append(buffer, "]");
        break;

      case SLIM_SPEC_BOOLEAN:
        hb_buffer_append(buffer, "[:attr, ");
        append_ruby_name(buffer, spec->name);
        hb_buffer_append(buffer, ", \"\"]");
        break;

      case SLIM_SPEC_QUOTED:
        hb_buffer_append(buffer, "[:attr, ");
        append_ruby_name(buffer, spec->name);
        hb_buffer_append(buffer, ", ");
        append_quoted_value_ruby(buffer, spec->children, false);
        hb_buffer_append(buffer, "]");
        break;

      case SLIM_SPEC_CODE: append_code_entry(parser, buffer, spec->name, spec->from, spec->to, spec->raw); break;

      case SLIM_SPEC_SPLAT:
        hb_buffer_append(buffer, "[:splat, (");
        hb_buffer_append_string(buffer, source_slice(parser, spec->from, spec->to));
        hb_buffer_append(buffer, ")]");
        break;
    }
  }

  hb_buffer_append(buffer, "]");
}

static void free_open_tag_children(slim_parser_T* parser, AST_HTML_OPEN_TAG_NODE_T* open_tag) {
  for (size_t index = 0; index < hb_array_size(open_tag->children); index++) {
    ast_node_free(hb_array_get(open_tag->children, index), parser->allocator);
  }

  open_tag->children->size = 0;
}

static void free_class_parts(slim_parser_T* parser, slim_attributes_T* attributes) {
  for (size_t index = 0; index < hb_array_size(attributes->class_parts); index++) {
    free_class_part_nodes(parser, hb_array_get(attributes->class_parts, index));
  }
}

// Emits the tag's attributes once they are all parsed. A tag with a splat (or a `data=`/`aria=` Ruby value)
// renders all of its attributes through `_slim_splat`, which merges classes, expands data/aria hashes and
// drops nil/false values like Slim does:
//
//   #a.b *attrs  ->  <div<%== _slim_splat.([[:attr, "class", "b"], [:attr, "id", "a"], [:splat, (attrs)]]) %>>
static void finish_attributes(
  slim_parser_T* parser,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  slim_attributes_T* attributes
) {
  if (!attributes->splat) {
    emit_class_attribute(parser, open_tag, attributes);
    return;
  }

  hb_buffer_T content;
  hb_buffer_init(&content, 128, parser->allocator);
  hb_buffer_append(&content, " _slim_splat.(");
  build_splat_entries(parser, attributes, &content);
  hb_buffer_append(&content, ") ");

  uint32_t at = open_tag->tag_name ? open_tag->tag_name->range.to : 0;

  free_open_tag_children(parser, open_tag);
  free_class_parts(parser, attributes);

  hb_array_append(
    open_tag->children,
    indented_synthetic_erb_node(&parser->builder, "<%==", hb_buffer_value(&content), at)
  );
  parser->uses_splat_helper = true;

  hb_buffer_free(&content);
}

// A Ruby attribute value (`attr=ruby`). Slim::CodeAttributes omits the attribute when the value is nil or
// false and renders a bare attribute when it is true; Ruby literals are resolved at parse time:
//
//   href=@url   ->  <% if @url == true %>href<% elsif @url %>href="<%= @url %>"<% end %>
//   href=url_for(x)
//               ->  <% if (_slim_href = url_for(x)) == true %>href<% elsif _slim_href %>href="<%= _slim_href %>"<% end
//               %>
static void add_code_attribute(
  slim_parser_T* parser,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  slim_attributes_T* attributes,
  uint32_t name_from,
  uint32_t name_to,
  token_T* equals,
  uint32_t code_from,
  uint32_t code_to,
  bool raw
) {
  hb_string_T name = source_slice(parser, name_from, name_to);
  hb_string_T code = source_slice(parser, code_from, code_to);

  if (is_class_attribute(name)) {
    token_free(equals, parser->allocator);

    add_class_part(
      parser,
      open_tag,
      attributes,
      (slim_class_part_T) { .kind = SLIM_CLASS_CODE,
                            .name_from = name_from,
                            .name_to = name_to,
                            .from = code_from,
                            .to = code_to,
                            .raw = raw }
    );

    return;
  }

  note_attribute_name(parser, attributes, name, name_from, name_to);
  record_spec(parser, attributes, SLIM_SPEC_CODE, name, code_from, code_to, NULL, raw);

  if (hb_string_equals(code, hb_string("true"))) {
    token_free(equals, parser->allocator);
    append_attribute_node(parser, open_tag, name, name_from, name_to, NULL, NULL, NULL, NULL, name_to);
    return;
  }

  if (hb_string_equals(code, hb_string("false")) || hb_string_equals(code, hb_string("nil"))) {
    token_free(equals, parser->allocator);
    return;
  }

  hb_buffer_T subject;
  hb_buffer_init(&subject, 32, parser->allocator);

  hb_buffer_T condition;
  hb_buffer_init(&condition, code.length + 64, parser->allocator);
  hb_buffer_append(&condition, " if ");

  if (is_simple_reference(code)) {
    hb_buffer_append_string(&subject, code);
    hb_buffer_append_string(&condition, code);
  } else {
    hb_buffer_append(&subject, "_slim_");

    for (uint32_t offset = 0; offset < name.length; offset++) {
      char character = name.data[offset];
      bool plain = (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
                || (character >= '0' && character <= '9') || character == '_';

      hb_buffer_append_char(&subject, plain ? character : '_');
    }

    hb_buffer_append(&condition, "(");
    hb_buffer_append(&condition, hb_buffer_value(&subject));
    hb_buffer_append(&condition, " = ");
    hb_buffer_append_string(&condition, code);
    hb_buffer_append(&condition, ")");
  }

  hb_buffer_append(&condition, " == true ");

  hb_buffer_T elsif;
  hb_buffer_init(&elsif, 64, parser->allocator);
  hb_buffer_append(&elsif, " elsif ");
  hb_buffer_append(&elsif, hb_buffer_value(&subject));
  hb_buffer_append(&elsif, " ");

  hb_buffer_T output;
  hb_buffer_init(&output, 64, parser->allocator);
  hb_buffer_append(&output, " ");
  hb_buffer_append(&output, hb_buffer_value(&subject));
  hb_buffer_append(&output, " ");

  // The whitespace before each attribute is inside the condition, so an omitted attribute leaves no stray space.
  AST_NODE_T* if_node =
    indented_erb_node(&parser->builder, "<%", code_from, code_from, code_to, NULL, hb_buffer_value(&condition));
  hb_array_append(open_tag->children, if_node);
  hb_array_append(open_tag->children, indented_whitespace_node(&parser->builder, name_from));

  AST_HTML_ATTRIBUTE_NODE_T* bare = indented_attribute_node(
    &parser->builder,
    indented_attribute_name_node(&parser->builder, name, name_from, name_to),
    NULL,
    NULL,
    NULL,
    NULL,
    name_from,
    name_to
  );
  hb_array_append(open_tag->children, bare);

  hb_array_append(
    open_tag->children,
    indented_synthetic_erb_node(&parser->builder, "<%", hb_buffer_value(&elsif), code_to)
  );
  hb_array_append(open_tag->children, indented_whitespace_node(&parser->builder, name_from));

  hb_array_T* children = hb_array_init(1, parser->allocator);
  hb_array_append(
    children,
    indented_synthetic_erb_node(&parser->builder, raw ? "<%==" : "<%=", hb_buffer_value(&output), code_to)
  );

  hb_array_append(
    open_tag->children,
    indented_attribute_node(
      &parser->builder,
      indented_attribute_name_node(&parser->builder, name, name_from, name_to),
      equals,
      indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, code_from),
      children,
      indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, code_to),
      name_from,
      code_to
    )
  );

  AST_NODE_T* end_node = indented_synthetic_erb_node(&parser->builder, "<%", " end ", code_to);
  hb_array_append(open_tag->children, end_node);
  open_tag->base.location.end = end_node->location.end;

  hb_buffer_free(&output);
  hb_buffer_free(&elsif);
  hb_buffer_free(&condition);
  hb_buffer_free(&subject);
}

// `.class` / `#id` shortcut: a static value, without interpolation.
static void add_shortcut_attribute(
  slim_parser_T* parser,
  AST_HTML_OPEN_TAG_NODE_T* open_tag,
  slim_attributes_T* attributes,
  const char* name,
  uint32_t shortcut_at,
  uint32_t value_from,
  uint32_t value_to
) {
  hb_array_T* children = hb_array_init(1, parser->allocator);

  hb_array_append(
    children,
    indented_literal_node(&parser->builder, source_slice(parser, value_from, value_to), value_from, value_to)
  );

  if (strcmp(name, "class") == 0) {
    add_class_part(
      parser,
      open_tag,
      attributes,
      (slim_class_part_T) { .kind = SLIM_CLASS_SHORTCUT,
                            .name_from = shortcut_at,
                            .name_to = shortcut_at,
                            .from = value_from,
                            .to = value_to,
                            .children = children }
    );

    return;
  }

  note_attribute_name(parser, attributes, hb_string_from_c_string(name), shortcut_at, value_to);
  record_spec(parser, attributes, SLIM_SPEC_STATIC, hb_string_from_c_string(name), value_from, value_to, NULL, false);

  append_attribute_node(
    parser,
    open_tag,
    hb_string_from_c_string(name),
    shortcut_at,
    shortcut_at,
    indented_synthetic_token(&parser->builder, "=", TOKEN_EQUALS, value_from),
    indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, value_from),
    children,
    indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, value_to),
    value_to
  );
}

// Slim::Parser#parse_quoted_attribute, with `#{}` interpolation. Returns false at the end of the file.
static bool parse_quoted_value(slim_parser_T* parser, char quote, hb_array_T* children) {
  slim_text_T text;
  text_init(parser, &text, children, true);

  int64_t depth = 0;
  uint32_t segment_from = parser->cursor;
  bool closed = false;

  while (current_line(parser)) {
    uint32_t limit = line_limit(parser);
    char character = peek(parser);

    if (parser->cursor >= limit || (character == '\\' && parser->cursor + 1 >= limit)) {
      bool backslash = parser->cursor < limit;

      interpolate(parser, &text, segment_from, parser->cursor);
      text_append_synthetic(&text, backslash ? " " : "\n", parser->cursor);
      finish_line(parser);
      segment_from = parser->cursor;
      continue;
    }

    if (depth == 0 && character == quote) {
      closed = true;
      break;
    }

    if (character == '{') {
      depth++;
    } else if (character == '}') {
      depth--;
    }

    parser->cursor++;
  }

  if (closed) { interpolate(parser, &text, segment_from, parser->cursor); }

  text_flush(parser, &text);
  text_free(&text);

  if (!closed) {
    syntax_error(parser, "Unclosed quoted attribute value", "a closing quote", parser->cursor, parser->cursor);
  }

  return closed;
}

static void parse_attributes(slim_parser_T* parser, AST_HTML_OPEN_TAG_NODE_T* open_tag, slim_attributes_T* attributes) {
  char delimiter = '\0';
  uint32_t save = parser->cursor;

  skip_spaces(parser);
  delimiter = closing_delimiter(peek(parser));

  if (delimiter) {
    parser->cursor++;
  } else {
    parser->cursor = save;
  }

  while (current_line(parser)) {
    uint32_t attempt = parser->cursor;
    skip_spaces(parser);

    char character = peek(parser);

    // Splat attributes: `*hash`
    if (character == '*' && char_at(parser, parser->cursor + 1) != '\0'
        && !indented_is_space(char_at(parser, parser->cursor + 1))) {
      uint32_t splat_at = parser->cursor;
      parser->cursor++;

      uint32_t code_from = parser->cursor;
      uint32_t code_to = parse_ruby_code(parser, delimiter);

      // Splats are rendered through the tag's Slim::Splat::Builder equivalent (see `finish_attributes`).
      (void) splat_at;
      record_spec(parser, attributes, SLIM_SPEC_SPLAT, hb_string("*"), code_from, code_to, NULL, false);
      continue;
    }

    uint32_t name_from = parser->cursor;

    while (is_attribute_name_character(peek(parser))) {
      parser->cursor++;
    }

    uint32_t name_to = parser->cursor;

    if (name_to > name_from) {
      skip_spaces(parser);

      if (peek(parser) == '=') {
        uint32_t equals_at = parser->cursor;
        parser->cursor++;

        bool raw = false;

        if (peek(parser) == '=') {
          raw = true;
          parser->cursor++;
        }

        skip_spaces(parser);
        character = peek(parser);

        token_T* equals = indented_source_token(&parser->builder, equals_at, equals_at + 1, TOKEN_EQUALS);
        hb_string_T name = source_slice(parser, name_from, name_to);

        if (character == '"' || character == '\'') {
          uint32_t open_at = parser->cursor;
          // Escaped values can't contain a raw `"`, so they are always printed with double quotes, like Slim renders.
          bool normalize_quote = character == '\'' && !raw;
          token_T* open_quote =
            normalize_quote ? indented_owned_token(&parser->builder, hb_string("\""), TOKEN_QUOTE, open_at, open_at + 1)
                            : indented_source_token(&parser->builder, open_at, open_at + 1, TOKEN_QUOTE);
          parser->cursor++;

          hb_array_T* children = hb_array_init(2, parser->allocator);
          bool closed = parse_quoted_value(parser, character, children);

          token_T* close_quote = NULL;

          if (closed) {
            close_quote = normalize_quote
                          ? indented_owned_token(
                              &parser->builder,
                              hb_string("\""),
                              TOKEN_QUOTE,
                              parser->cursor,
                              parser->cursor + 1
                            )
                          : indented_source_token(&parser->builder, parser->cursor, parser->cursor + 1, TOKEN_QUOTE);
            parser->cursor++;
          } else {
            close_quote = indented_synthetic_token(&parser->builder, "\"", TOKEN_QUOTE, parser->cursor);
          }

          if (is_class_attribute(name)) {
            add_class_part(
              parser,
              open_tag,
              attributes,
              (slim_class_part_T) { .kind = SLIM_CLASS_QUOTED,
                                    .name_from = name_from,
                                    .name_to = name_to,
                                    .from = open_at + 1,
                                    .to = closed ? parser->cursor - 1 : parser->cursor,
                                    .equals = equals,
                                    .open_quote = open_quote,
                                    .close_quote = close_quote,
                                    .children = children,
                                    .raw = raw }
            );
          } else {
            note_attribute_name(parser, attributes, name, name_from, name_to);
            if (!raw) { escape_literal_children(parser, children); }
            record_spec(parser, attributes, SLIM_SPEC_QUOTED, name, open_at + 1, parser->cursor, children, raw);

            append_attribute_node(
              parser,
              open_tag,
              name,
              name_from,
              name_to,
              equals,
              open_quote,
              children,
              close_quote,
              parser->cursor
            );
          }

          if (!closed) { return; }

          continue;
        }

        uint32_t code_from = parser->cursor;
        uint32_t code_to = parse_ruby_code(parser, delimiter);

        if (code_to <= code_from) {
          syntax_error(parser, "Invalid empty attribute", "an attribute value", code_to, code_to);
          token_free(equals, parser->allocator);
          continue;
        }

        add_code_attribute(parser, open_tag, attributes, name_from, name_to, equals, code_from, code_to, raw);

        continue;
      }

      if (delimiter) {
        parser->cursor = name_to;
        character = peek(parser);

        if (character == '\0' || indented_is_space(character) || character == delimiter) {
          hb_string_T name = source_slice(parser, name_from, name_to);

          if (!is_class_attribute(name)) {
            note_attribute_name(parser, attributes, name, name_from, name_to);
            record_spec(parser, attributes, SLIM_SPEC_BOOLEAN, name, name_to, name_to, NULL, false);
          }
          append_attribute_node(parser, open_tag, name, name_from, name_to, NULL, NULL, NULL, NULL, name_to);

          continue;
        }
      }
    }

    if (!delimiter) {
      parser->cursor = attempt;
      return;
    }

    parser->cursor = attempt;
    skip_spaces(parser);

    if (peek(parser) == delimiter) {
      parser->cursor++;
      return;
    }

    if (rest_is_blank(parser)) {
      finish_line(parser);

      if (!current_line(parser)) {
        char message[64];
        snprintf(message, sizeof(message), "`%c`", delimiter);
        syntax_error(parser, "Unclosed attribute list", message, parser->source.length, parser->source.length);
        return;
      }

      continue;
    }

    syntax_error(
      parser,
      "Invalid attribute",
      "an attribute or the closing delimiter",
      parser->cursor,
      line_limit(parser)
    );

    // Recover by skipping to the closing delimiter on this line.
    while (peek(parser) != '\0' && peek(parser) != delimiter) {
      parser->cursor++;
    }

    if (peek(parser) == delimiter) { parser->cursor++; }

    return;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Embedded engines
// ---------------------------------------------------------------------------------------------------------------------

static const char* embedded_engines[] = {
  "markdown", "textile", "rdoc", "coffee", "less", "sass", "scss", "javascript", "css", "ruby",
};

// Slim's embedded engine regex: /\A(engine)(?:\s*(?:(.*)))?:(\s*)/ — the colon is the last one on the line.
static bool match_embedded(const slim_parser_T* parser, uint32_t* name_to, uint32_t* colon_at) {
  for (size_t index = 0; index < sizeof(embedded_engines) / sizeof(embedded_engines[0]); index++) {
    if (!starts_with(parser, parser->cursor, embedded_engines[index])) { continue; }

    uint32_t after_name = parser->cursor + (uint32_t) strlen(embedded_engines[index]);
    uint32_t last_colon = UINT32_MAX;

    for (uint32_t offset = after_name; offset < line_limit(parser); offset++) {
      if (parser->text[offset] == ':') { last_colon = offset; }
    }

    if (last_colon == UINT32_MAX) { continue; }

    *name_to = after_name;
    *colon_at = last_colon;

    return true;
  }

  return false;
}

static void parse_embedded(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  uint32_t name_from = parser->cursor;
  uint32_t name_to = 0;
  uint32_t colon_at = 0;
  match_embedded(parser, &name_to, &colon_at);

  hb_string_T engine = source_slice(parser, name_from, name_to);
  const char* tag = NULL;

  if (hb_string_equals(engine, hb_string("javascript"))) {
    tag = "script";
  } else if (hb_string_equals(engine, hb_string("css"))) {
    tag = "style";
  }

  // `ruby:` embeds Ruby code (Slim's RubyEngine): the verbatim block becomes one `<% code %>` tag.
  if (hb_string_equals(engine, hb_string("ruby"))) {
    parser->cursor = colon_at + 1;
    skip_spaces(parser);

    const indented_line_T* line = current_line(parser);
    hb_array_T* unused = hb_array_init(0, parser->allocator);

    slim_text_T text;
    text_init(parser, &text, unused, true);
    text.raw = true;
    parse_text_block(parser, &text, parser->cursor, (int64_t) (parser->cursor - line->start), indent);

    if (hb_buffer_length(&text.buffer) > 0) {
      hb_buffer_T code;
      hb_buffer_init(&code, hb_buffer_length(&text.buffer) + 4, parser->allocator);
      hb_buffer_append(&code, " ");
      hb_buffer_append_with_length(&code, hb_buffer_value(&text.buffer), hb_buffer_length(&text.buffer));
      hb_buffer_append(&code, " ");

      hb_array_append(
        output,
        indented_erb_node(&parser->builder, "<%", name_from, text.from, text.to, NULL, hb_buffer_value(&code))
      );

      hb_buffer_free(&code);
    }

    text_free(&text);
    hb_array_free(&unused);

    return;
  }

  if (!tag) {
    syntax_error(parser, "Unsupported embedded engine", "`javascript:`, `css:` or `ruby:`", name_from, colon_at + 1);

    const indented_line_T* line = NULL;
    finish_line(parser);

    while ((line = current_line(parser)) && (line->blank || line->indent > indent)) {
      finish_line(parser);
    }

    return;
  }

  token_T* tag_name =
    indented_owned_token(&parser->builder, hb_string_from_c_string(tag), TOKEN_IDENTIFIER, name_from, name_to);
  AST_HTML_OPEN_TAG_NODE_T* open_tag = indented_open_tag_node(&parser->builder, tag_name, name_from);
  slim_attributes_T attributes;
  attributes_init(parser, &attributes);

  parser->cursor = name_to;
  parser->limit = colon_at;
  parse_attributes(parser, open_tag, &attributes);
  parser->limit = 0;

  finish_attributes(parser, open_tag, &attributes);
  attributes_free(parser, &attributes);
  indented_open_tag_finish(&parser->builder, open_tag, ">", colon_at + 1, false);

  parser->cursor = colon_at + 1;
  skip_spaces(parser);

  const indented_line_T* line = current_line(parser);
  uint32_t first_from = parser->cursor;
  int64_t text_indent = (int64_t) (first_from - line->start) + (int64_t) (colon_at - name_to);

  hb_array_T* body = hb_array_init(2, parser->allocator);
  slim_text_T text;
  text_init(parser, &text, body, true);
  parse_text_block(parser, &text, first_from, text_indent, indent);
  text_flush(parser, &text);
  text_free(&text);

  hb_array_append(output, indented_element_node(&parser->builder, open_tag, body, false, false, parser->last_end));
}

// ---------------------------------------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------------------------------------

static uint32_t scan_tag_name(const slim_parser_T* parser, uint32_t from) {
  uint32_t offset = from;

  while (is_word_character(char_at(parser, offset)) || char_at(parser, offset) == ':'
         || char_at(parser, offset) == '-') {
    offset++;
  }

  while (offset > from + 1 && (parser->text[offset - 1] == ':' || parser->text[offset - 1] == '-')) {
    offset--;
  }

  return offset;
}

// Shortcut values: /((?:\p{Word}|-|\/\d+|:(\w|-)+)*)/
static uint32_t scan_shortcut_value(const slim_parser_T* parser, uint32_t from) {
  uint32_t offset = from;

  while (true) {
    char character = char_at(parser, offset);

    if (is_word_character(character) || character == '-') {
      offset++;
    } else if (character == '/' && char_at(parser, offset + 1) >= '0' && char_at(parser, offset + 1) <= '9') {
      offset++;
      while (char_at(parser, offset) >= '0' && char_at(parser, offset) <= '9') {
        offset++;
      }
    } else if (character == ':'
               && (is_word_character(char_at(parser, offset + 1)) || char_at(parser, offset + 1) == '-')) {
      offset++;
      while (is_word_character(char_at(parser, offset)) || char_at(parser, offset) == '-') {
        offset++;
      }
    } else {
      break;
    }
  }

  return offset;
}

static bool is_tag_start(const slim_parser_T* parser) {
  char character = peek(parser);

  if (character == '*') {
    char next = char_at(parser, parser->cursor + 1);
    return next != '\0' && !indented_is_space(next);
  }

  return character == '#' || character == '.' || is_word_character(character);
}

static void parse_tag(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  uint32_t start = parser->cursor;
  token_T* tag_name = NULL;
  char character = peek(parser);

  // `*attributes Content` is a dynamic tag: the name comes from the splat's `tag` key (Slim::Splat).
  bool dynamic_tag = character == '*';

  if (dynamic_tag) {
    tag_name = indented_owned_token(&parser->builder, hb_string("*"), TOKEN_IDENTIFIER, start, start);
  } else if (character == '#' || character == '.') {
    tag_name = indented_owned_token(&parser->builder, hb_string("div"), TOKEN_IDENTIFIER, start, start);
  } else {
    uint32_t name_to = scan_tag_name(parser, start);
    tag_name = indented_source_token(&parser->builder, start, name_to, TOKEN_IDENTIFIER);
    parser->cursor = name_to;
  }

  AST_HTML_OPEN_TAG_NODE_T* open_tag = indented_open_tag_node(&parser->builder, tag_name, start);
  slim_attributes_T attributes;
  attributes_init(parser, &attributes);

  while ((character = peek(parser)) == '#' || character == '.') {
    uint32_t shortcut_at = parser->cursor;
    parser->cursor++;

    uint32_t value_from = parser->cursor;
    uint32_t value_to = scan_shortcut_value(parser, value_from);
    parser->cursor = value_to;

    add_shortcut_attribute(
      parser,
      open_tag,
      &attributes,
      character == '#' ? "id" : "class",
      shortcut_at,
      value_from,
      value_to
    );
  }

  bool leading_whitespace = false;
  bool trailing_whitespace = false;

  while ((character = peek(parser)) == '<' || character == '>' || character == '\'') {
    if (character == '<') { leading_whitespace = true; }
    if (character == '>') { trailing_whitespace = true; }
    parser->cursor++;
  }

  parse_attributes(parser, open_tag, &attributes);

  hb_buffer_T dynamic_entries;

  if (dynamic_tag) {
    hb_buffer_init(&dynamic_entries, 128, parser->allocator);
    build_splat_entries(parser, &attributes, &dynamic_entries);
    free_open_tag_children(parser, open_tag);
    free_class_parts(parser, &attributes);
    parser->uses_splat_helper = true;
  } else {
    finish_attributes(parser, open_tag, &attributes);
  }

  attributes_free(parser, &attributes);

  uint32_t header_end = parser->cursor;
  bool is_void = is_void_element(tag_name->value);
  bool self_closing = false;
  hb_array_T* body = hb_array_init(4, parser->allocator);

  uint32_t save = parser->cursor;
  skip_spaces(parser);
  character = peek(parser);

  if (character == ':') {
    // Inline nesting: `ul: li: a text`
    parser->cursor++;
    skip_spaces(parser);

    uint32_t name_to = 0;
    uint32_t colon_at = 0;

    if (match_embedded(parser, &name_to, &colon_at)) {
      parse_embedded(parser, body, indent);
    } else if (is_tag_start(parser)) {
      parse_tag(parser, body, indent);
    } else {
      syntax_error(parser, "Invalid inline nesting", "a tag after `:`", parser->cursor, line_limit(parser));
      finish_line(parser);
      check_unexpected_children(parser, indent, body);
    }
  } else if (character == '=') {
    uint32_t output_start = parser->cursor;
    parser->cursor++;

    bool raw = false;

    if (peek(parser) == '=') {
      raw = true;
      parser->cursor++;
    }

    while ((character = peek(parser)) == '\'' || character == '<' || character == '>') {
      if (character == '<') { leading_whitespace = true; }
      if (character == '>') { trailing_whitespace = true; }
      parser->cursor++;
    }

    parse_output_code(parser, body, output_start, raw, indent);
  } else if (character == '/') {
    parser->cursor++;
    skip_spaces(parser);

    if (!rest_is_blank(parser)) {
      syntax_error(parser, "Unexpected text after closed tag", "end of line", parser->cursor, line_limit(parser));
    }

    self_closing = true;
    finish_line(parser);
    check_unexpected_children(parser, indent, body);
  } else if (rest_is_blank(parser)) {
    finish_line(parser);
    parse_block(parser, indent, body);
  } else {
    parser->cursor = save;
    if (peek(parser) == ' ') { parser->cursor++; }

    const indented_line_T* line = current_line(parser);
    slim_text_T text;
    text_init(parser, &text, body, false);
    parse_text_block(parser, &text, parser->cursor, (int64_t) (parser->cursor - line->start), indent);
    text_flush(parser, &text);
    text_free(&text);
  }

  if (leading_whitespace) { append_space(parser, output, start); }

  if (dynamic_tag) {
    char variable[32];
    snprintf(variable, sizeof(variable), "_slim_tag%u", ++parser->dynamic_tag_count);

    hb_buffer_T code;
    hb_buffer_init(&code, hb_buffer_length(&dynamic_entries) + 64, parser->allocator);

    hb_buffer_append(&code, " ");
    hb_buffer_append(&code, variable);
    hb_buffer_append(&code, " = _slim_splat.(");
    hb_buffer_append(&code, hb_buffer_value(&dynamic_entries));
    hb_buffer_append(&code, ", true) ");
    hb_array_append(output, indented_synthetic_erb_node(&parser->builder, "<%", hb_buffer_value(&code), start));

    hb_buffer_clear(&code);
    hb_buffer_append(&code, " \"<#{");
    hb_buffer_append(&code, variable);
    hb_buffer_append(&code, "[0]}#{");
    hb_buffer_append(&code, variable);
    hb_buffer_append(&code, self_closing ? "[1]} />\" " : "[1]}>\" ");
    hb_array_append(output, indented_synthetic_erb_node(&parser->builder, "<%==", hb_buffer_value(&code), header_end));

    if (!self_closing) {
      for (size_t index = 0; index < hb_array_size(body); index++) {
        hb_array_append(output, hb_array_get(body, index));
      }

      hb_buffer_clear(&code);
      hb_buffer_append(&code, " \"</#{");
      hb_buffer_append(&code, variable);
      hb_buffer_append(&code, "[0]}>\" ");
      hb_array_append(
        output,
        indented_synthetic_erb_node(&parser->builder, "<%==", hb_buffer_value(&code), parser->last_end)
      );
    }

    hb_array_free(&body);
    hb_buffer_free(&code);
    hb_buffer_free(&dynamic_entries);
    ast_node_free((AST_NODE_T*) open_tag, parser->allocator);

    if (trailing_whitespace) { append_space(parser, output, parser->last_end); }

    return;
  }

  indented_open_tag_finish(&parser->builder, open_tag, self_closing ? "/>" : ">", header_end, is_void || self_closing);

  hb_array_append(
    output,
    indented_element_node(&parser->builder, open_tag, body, is_void, self_closing, parser->last_end)
  );

  if (trailing_whitespace) { append_space(parser, output, parser->last_end); }
}

// ---------------------------------------------------------------------------------------------------------------------
// Other line types
// ---------------------------------------------------------------------------------------------------------------------

static void parse_text_line(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  char indicator = peek(parser);
  uint32_t start = parser->cursor;
  parser->cursor++;

  // /\A([\|'])([<>]{1,2}(?: |\z)| ?)/
  bool leading_whitespace = false;
  bool trailing_whitespace = indicator == '\'';
  uint32_t spaces = 0;
  uint32_t modifiers_to = parser->cursor;

  while (modifiers_to < parser->cursor + 2
         && (char_at(parser, modifiers_to) == '<' || char_at(parser, modifiers_to) == '>')) {
    modifiers_to++;
  }

  if (modifiers_to > parser->cursor
      && (char_at(parser, modifiers_to) == ' ' || char_at(parser, modifiers_to) == '\0')) {
    for (uint32_t offset = parser->cursor; offset < modifiers_to; offset++) {
      if (parser->text[offset] == '<') { leading_whitespace = true; }
      if (parser->text[offset] == '>') { trailing_whitespace = true; }
    }

    parser->cursor = modifiers_to;
  }

  if (peek(parser) == ' ') {
    parser->cursor++;
    spaces = 1;
  }

  if (leading_whitespace) { append_space(parser, output, start); }

  slim_text_T text;
  text_init(parser, &text, output, false);
  parse_text_block(parser, &text, parser->cursor, (int64_t) indent + spaces + 1, indent);

  if (trailing_whitespace) { text_append_synthetic(&text, " ", parser->last_end); }

  text_flush(parser, &text);
  text_free(&text);
}

static bool contains(hb_string_T text, const char* needle) {
  size_t length = strlen(needle);

  for (uint32_t offset = 0; offset + length <= text.length; offset++) {
    if (strncmp(text.data + offset, needle, length) == 0) { return true; }
  }

  return false;
}

// Inline HTML lines (`<div class="a">`, `</div>`, `<br>`) are parsed with Herb's own HTML+ERB parser, with
// positions and ranges rebased onto the Slim source. Unclosed open tags and their close tags stay flat, like
// the ERB parser leaves them, so the analyzer pairs them into elements across the Slim content in between.
// Lines with `#{}` interpolation or a literal `<%` fall back to text (Slim renders them verbatim either way).
static void parse_inline_html(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  const indented_line_T* line = current_line(parser);
  uint32_t from = parser->cursor;
  uint32_t to = line->end;
  hb_string_T html = source_slice(parser, from, to);

  if (!contains(html, "#{") && !contains(html, "<%") && !contains(html, "%>")) {
    char* copy = hb_allocator_strndup(parser->allocator, html.data, html.length);

    parser_options_T options = HERB_DEFAULT_PARSER_OPTIONS;
    options.analyze = false;
    options.track_whitespace = true;
    options.timeout_ms = 0;
    options.max_errors = 0;
    options.start_line = (uint32_t) parser->line + 1;
    options.start_column = indented_builder_position(&parser->builder, from).column;

    AST_DOCUMENT_NODE_T* document = herb_parse(copy, &options, parser->allocator);

    for (size_t index = 0; index < hb_array_size(document->children); index++) {
      AST_NODE_T* child = hb_array_get(document->children, index);

      ast_node_rebase_tokens_with_range_offset(child, copy, parser->text + from, html.length, from);
      hb_array_append(output, child);
    }

    if (document->base.errors) {
      for (size_t index = 0; index < hb_array_size(document->base.errors); index++) {
        hb_array_append_lazy(&parser->errors, hb_array_get(document->base.errors, index), parser->allocator);
      }

      document->base.errors->size = 0;
    }

    document->children->size = 0;
    ast_node_free((AST_NODE_T*) document, parser->allocator);
    hb_allocator_dealloc(parser->allocator, copy);
  } else {
    slim_text_T text;
    text_init(parser, &text, output, false);
    interpolate(parser, &text, from, to);
    text_flush(parser, &text);
    text_free(&text);
  }

  finish_line(parser);
  parse_block(parser, indent, output);
}

static void parse_html_comment(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  uint32_t start = parser->cursor;
  parser->cursor += 2;

  uint32_t space = 0;

  if (peek(parser) == ' ') {
    parser->cursor++;
    space = 1;
  }

  hb_array_T* children = hb_array_init(1, parser->allocator);
  slim_text_T text;
  text_init(parser, &text, children, true);
  parse_text_block(parser, &text, parser->cursor, (int64_t) indent + space + 2, indent);
  text_flush(parser, &text);
  text_free(&text);

  hb_array_append(
    output,
    ast_html_comment_node_init(
      indented_synthetic_token(&parser->builder, "<!--", TOKEN_HTML_COMMENT_START, start),
      children,
      indented_synthetic_token(&parser->builder, "-->", TOKEN_HTML_COMMENT_END, parser->last_end),
      indented_builder_position(&parser->builder, start),
      indented_builder_position(&parser->builder, parser->last_end),
      NULL,
      parser->allocator
    )
  );
}

// `/[if IE]` conditional comments: `<!--[if IE]>...<![endif]-->`
static bool parse_conditional_comment(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  const indented_line_T* line = current_line(parser);
  uint32_t start = parser->cursor;

  if (line->content_end == 0 || parser->text[line->content_end - 1] != ']') { return false; }

  uint32_t condition_from = start + 2;
  uint32_t condition_to = line->content_end - 1;

  while (condition_from < condition_to && indented_is_space(parser->text[condition_from])) {
    condition_from++;
  }

  while (condition_to > condition_from && indented_is_space(parser->text[condition_to - 1])) {
    condition_to--;
  }

  hb_buffer_T buffer;
  hb_buffer_init(&buffer, condition_to - condition_from + 4, parser->allocator);
  hb_buffer_append(&buffer, "[");
  hb_buffer_append_with_length(&buffer, parser->text + condition_from, condition_to - condition_from);
  hb_buffer_append(&buffer, "]>");

  hb_array_T* children = hb_array_init(3, parser->allocator);
  hb_array_append(
    children,
    indented_literal_node(
      &parser->builder,
      hb_string_from_data(hb_buffer_value(&buffer), hb_buffer_length(&buffer)),
      condition_from,
      condition_to
    )
  );
  hb_buffer_free(&buffer);

  finish_line(parser);
  parse_block(parser, indent, children);

  hb_array_append(
    children,
    indented_literal_node(&parser->builder, hb_string("<![endif]"), parser->last_end, parser->last_end)
  );

  hb_array_append(
    output,
    ast_html_comment_node_init(
      indented_synthetic_token(&parser->builder, "<!--", TOKEN_HTML_COMMENT_START, start),
      children,
      indented_synthetic_token(&parser->builder, "-->", TOKEN_HTML_COMMENT_END, parser->last_end),
      indented_builder_position(&parser->builder, start),
      indented_builder_position(&parser->builder, parser->last_end),
      NULL,
      parser->allocator
    )
  );

  return true;
}

// Slim comments render nothing. They are kept as ERB comments so that no information is lost when
// converting between template languages.
static void parse_slim_comment(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  const indented_line_T* line = current_line(parser);
  uint32_t start = parser->cursor;
  uint32_t content_from = start + 1;
  uint32_t content_to = line->content_end > content_from ? line->content_end : content_from;

  finish_line(parser);

  while ((line = current_line(parser)) && (line->blank || line->indent > indent)) {
    if (!line->blank) { content_to = line->content_end; }
    finish_line(parser);
  }

  hb_string_T content = source_slice(parser, content_from, content_to);

  for (uint32_t index = 0; index + 1 < content.length; index++) {
    if (content.data[index] == '%' && content.data[index + 1] == '>') { return; }
  }

  hb_array_append(output, indented_erb_comment_node(&parser->builder, start, content_from, content_to));
}

typedef struct {
  const char* name;
  const char* value;
} slim_doctype_T;

// Temple::HTML::Fast::DOCTYPES for Slim's default :xhtml format.
static const slim_doctype_T doctypes[] = {
  { "html", " html" },
  { "5", " html" },
  { "1.1", " html PUBLIC \"-//W3C//DTD XHTML 1.1//EN\" \"http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd\"" },
  { "strict",
    " html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd\"" },
  { "frameset",
    " html PUBLIC \"-//W3C//DTD XHTML 1.0 Frameset//EN\" \"http://www.w3.org/TR/xhtml1/DTD/xhtml1-frameset.dtd\"" },
  { "mobile",
    " html PUBLIC \"-//WAPFORUM//DTD XHTML Mobile 1.2//EN\" "
    "\"http://www.openmobilealliance.org/tech/DTD/xhtml-mobile12.dtd\"" },
  { "basic",
    " html PUBLIC \"-//W3C//DTD XHTML Basic 1.1//EN\" \"http://www.w3.org/TR/xhtml-basic/xhtml-basic11.dtd\"" },
  { "transitional",
    " html PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\" "
    "\"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd\"" },
  { "svg", " svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\"" },
};

static void parse_doctype(slim_parser_T* parser, hb_array_T* output, uint32_t indent) {
  const indented_line_T* line = current_line(parser);
  uint32_t start = parser->cursor;

  parser->cursor += 7;
  skip_spaces(parser);

  uint32_t value_from = parser->cursor;
  uint32_t value_to = line->content_end > value_from ? line->content_end : value_from;
  hb_string_T value = source_slice(parser, value_from, value_to);

  finish_line(parser);

  if (value.length >= 3 && strncasecmp(value.data, "xml", 3) == 0
      && (value.length == 3 || indented_is_space(value.data[3]))) {
    hb_string_T encoding = hb_string_trim(hb_string_slice(value, 3));

    hb_buffer_T buffer;
    hb_buffer_init(&buffer, 64, parser->allocator);
    hb_buffer_append(&buffer, " version=\"1.0\" encoding=\"");

    if (encoding.length > 0) {
      hb_buffer_append_string(&buffer, encoding);
    } else {
      hb_buffer_append(&buffer, "utf-8");
    }

    hb_buffer_append(&buffer, "\" ");

    hb_array_T* children = hb_array_init(1, parser->allocator);
    hb_array_append(
      children,
      indented_literal_node(
        &parser->builder,
        hb_string_from_data(hb_buffer_value(&buffer), hb_buffer_length(&buffer)),
        value_from,
        value_to
      )
    );
    hb_buffer_free(&buffer);

    hb_array_append(
      output,
      ast_xml_declaration_node_init(
        indented_synthetic_token(&parser->builder, "<?xml", TOKEN_XML_DECLARATION, start),
        children,
        indented_synthetic_token(&parser->builder, "?>", TOKEN_XML_DECLARATION_END, value_to),
        indented_builder_position(&parser->builder, start),
        indented_builder_position(&parser->builder, value_to),
        NULL,
        parser->allocator
      )
    );

    check_unexpected_children(parser, indent, output);
    return;
  }

  const char* doctype = NULL;

  for (size_t index = 0; index < sizeof(doctypes) / sizeof(doctypes[0]); index++) {
    if (hb_string_equals_case_insensitive(value, hb_string_from_c_string(doctypes[index].name))) {
      doctype = doctypes[index].value;
      break;
    }
  }

  if (!doctype) {
    syntax_error(
      parser,
      "Invalid doctype",
      "a known doctype (html, 5, 1.1, strict, frameset, mobile, basic, transitional, svg, xml)",
      value_from,
      value_to
    );
    check_unexpected_children(parser, indent, output);
    return;
  }

  hb_array_T* children = hb_array_init(1, parser->allocator);
  hb_array_append(
    children,
    indented_literal_node(&parser->builder, hb_string_from_c_string(doctype), value_from, value_to)
  );

  hb_array_append(
    output,
    ast_html_doctype_node_init(
      indented_synthetic_token(&parser->builder, "<!DOCTYPE", TOKEN_HTML_DOCTYPE, start),
      children,
      indented_synthetic_token(&parser->builder, ">", TOKEN_HTML_TAG_END, value_to),
      indented_builder_position(&parser->builder, start),
      indented_builder_position(&parser->builder, value_to),
      NULL,
      parser->allocator
    )
  );

  check_unexpected_children(parser, indent, output);
}

static bool starts_with_word(const slim_parser_T* parser, const char* word) {
  if (!starts_with(parser, parser->cursor, word)) { return false; }

  return !is_word_character(char_at(parser, parser->cursor + (uint32_t) strlen(word)));
}

static void parse_line(slim_parser_T* parser, hb_array_T* output, slim_block_state_T* state, uint32_t indent) {
  char character = peek(parser);
  char next = char_at(parser, parser->cursor + 1);

  if (character == '/') {
    if (next == '!') {
      close_pending(parser, output, state);
      parse_html_comment(parser, output, indent);
      return;
    }

    if (next == '[') {
      close_pending(parser, output, state);
      if (parse_conditional_comment(parser, output, indent)) { return; }
    }

    parse_slim_comment(parser, output, indent);
    return;
  }

  if (character == '-') {
    parse_control(parser, output, state, indent);
    return;
  }

  close_pending(parser, output, state);

  if (character == '|' || character == '\'') {
    parse_text_line(parser, output, indent);
    return;
  }

  if (character == '<') {
    parse_inline_html(parser, output, indent);
    return;
  }

  if (character == '=') {
    parse_line_output(parser, output, indent);
    return;
  }

  uint32_t name_to = 0;
  uint32_t colon_at = 0;

  if (match_embedded(parser, &name_to, &colon_at)) {
    parse_embedded(parser, output, indent);
    return;
  }

  if (starts_with_word(parser, "doctype")) {
    parse_doctype(parser, output, indent);
    return;
  }

  if (is_tag_start(parser)) {
    parse_tag(parser, output, indent);
    return;
  }

  const indented_line_T* line = current_line(parser);

  if (character == '*') {
    syntax_error(parser, "Unsupported dynamic tag", "a tag name", parser->cursor, line->content_end);
  } else {
    syntax_error(
      parser,
      "Unknown line indicator",
      "a tag, text, code, comment or doctype",
      parser->cursor,
      line->content_end
    );
  }

  finish_line(parser);
  check_unexpected_children(parser, indent, output);
}

// Parses the lines indented deeper than `parent_indent` into `output`. The first line sets the block's
// indentation. Returns whether the block started with a continuation (`- when`, `- else`, ...) that
// the block closed itself (Slim's EndInserter semantics for `- case x` with indented `- when` lines).
static bool parse_block(slim_parser_T* parser, int64_t parent_indent, hb_array_T* output) {
  const indented_line_T* line = NULL;

  while ((line = current_line(parser)) && line->blank) {
    finish_line(parser);
  }

  if (!line || (int64_t) line->indent <= parent_indent) { return false; }

  uint32_t block_indent = line->indent;
  slim_block_state_T state = { .pending = INDENTED_RUBY_STATEMENT, .closed_leading_continuation = false };

  while ((line = current_line(parser))) {
    if (line->blank) {
      finish_line(parser);
      continue;
    }

    if ((int64_t) line->indent <= parent_indent) { break; }

    if (line->indent < block_indent) {
      indentation_error(parser, "Malformed indentation", line, block_indent);
    } else if (line->indent > block_indent) {
      indentation_error(parser, "Unexpected indentation", line, block_indent);
    }

    parser->cursor = line->content_start;
    parse_line(parser, output, &state, line->indent);
  }

  close_pending(parser, output, &state);

  return state.closed_leading_continuation;
}

static bool count_node_errors(const AST_NODE_T* node, void* data) {
  if (node == NULL) { return false; }

  if (node->errors != NULL) { *((uint32_t*) data) += (uint32_t) hb_array_size(node->errors); }

  return true;
}

AST_DOCUMENT_NODE_T* herb_slim_parse(const char* source, const parser_options_T* options, hb_allocator_T* allocator) {
  parser_options_T parser_options = HERB_DEFAULT_PARSER_OPTIONS;
  if (options != NULL) { parser_options = *options; }

  uint32_t error_count = 0;
  if (parser_options.error_count == NULL) { parser_options.error_count = &error_count; }

  parser_options_set_deadline(&parser_options);

  slim_parser_T parser = { 0 };

  parser.options = &parser_options;
  parser.allocator = allocator;
  parser.errors = NULL;

  indented_source_init(&parser.source, source, SLIM_TAB_SIZE, allocator);
  indented_builder_init(&parser.builder, &parser.source, &parser_options, hb_string("Slim"), allocator);

  parser.text = parser.source.source;
  parser.cursor = parser.source.line_count > 0 ? parser.source.lines[0].content_start : 0;

  hb_array_T* children = hb_array_init(8, allocator);
  parse_block(&parser, -1, children);

  if (parser.uses_splat_helper) {
    hb_array_T* with_helper = hb_array_init(hb_array_size(children) + 1, allocator);
    hb_array_append(with_helper, indented_synthetic_erb_node(&parser.builder, "<%", SLIM_SPLAT_HELPER, 0));

    for (size_t index = 0; index < hb_array_size(children); index++) {
      hb_array_append(with_helper, hb_array_get(children, index));
    }

    hb_array_free(&children);
    children = with_helper;
  }

  AST_DOCUMENT_NODE_T* document = ast_document_node_init(
    children,
    NULL,
    HERB_PRISM_NODE_EMPTY,
    (position_T) { .line = 1, .column = 0 },
    indented_source_position(&parser.source, parser.source.length),
    parser.errors ? parser.errors : hb_array_init(0, allocator),
    allocator
  );

  if (parser_options.analyze) {
    herb_ruby_program_T ruby_program = indented_builder_ruby_program(&parser.builder);

    herb_analyze_parse_tree_with_ruby_program(document, parser.text, &ruby_program, &parser_options, allocator);
  }

  indented_builder_free(&parser.builder);
  indented_source_free(&parser.source);

  *parser_options.error_count = 0;
  herb_visit_node((AST_NODE_T*) document, count_node_errors, parser_options.error_count);

  if (parser_options_past_deadline(&parser_options)) {
    append_timeout_error(
      parser_options.timeout_ms,
      document->base.location.start,
      document->base.location.end,
      allocator,
      &document->base.errors,
      &parser_options
    );
  }

  return document;
}
