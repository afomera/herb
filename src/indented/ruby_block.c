#include "../include/indented/ruby_block.h"

#include <prism.h>
#include <stdlib.h>
#include <string.h>

static bool is_identifier_character(char character) {
  return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
      || (character >= '0' && character <= '9') || character == '_' || (unsigned char) character >= 0x80;
}

static bool starts_with_keyword(const char* code, size_t length, const char* keyword) {
  size_t keyword_length = strlen(keyword);

  if (length < keyword_length || strncmp(code, keyword, keyword_length) != 0) { return false; }
  if (length == keyword_length) { return true; }

  char next = code[keyword_length];

  return !is_identifier_character(next) && next != '?' && next != '!' && next != ':';
}

static bool parses_cleanly(const char* code, size_t length, const char* suffix) {
  size_t suffix_length = suffix ? strlen(suffix) : 0;
  char* buffer = malloc(length + suffix_length + 1);
  if (!buffer) { return false; }

  memcpy(buffer, code, length);
  if (suffix_length > 0) { memcpy(buffer + length, suffix, suffix_length); }
  buffer[length + suffix_length] = '\0';

  pm_parser_t parser;
  pm_options_t options = { 0, .partial_script = true };
  pm_parser_init(&parser, (const uint8_t*) buffer, length + suffix_length, &options);

  pm_node_t* root = pm_parse(&parser);
  bool clean = parser.error_list.size == 0;

  pm_node_destroy(&parser, root);
  pm_parser_free(&parser);
  pm_options_free(&options);
  free(buffer);

  return clean;
}

indented_ruby_kind_T indented_ruby_classify(const char* code, size_t length) {
  while (length > 0 && (*code == ' ' || *code == '\t')) {
    code++;
    length--;
  }

  while (length > 0 && (code[length - 1] == ' ' || code[length - 1] == '\t')) {
    length--;
  }

  if (length == 0) { return INDENTED_RUBY_STATEMENT; }

  static const char* continuation_keywords[] = { "else", "elsif", "when", "in", "rescue", "ensure" };

  for (size_t index = 0; index < sizeof(continuation_keywords) / sizeof(continuation_keywords[0]); index++) {
    if (starts_with_keyword(code, length, continuation_keywords[index])) { return INDENTED_RUBY_CONTINUATION; }
  }

  if (starts_with_keyword(code, length, "end")) { return INDENTED_RUBY_END; }
  if (code[0] == '}') { return INDENTED_RUBY_CLOSE_BRACE; }

  if (parses_cleanly(code, length, NULL)) { return INDENTED_RUBY_STATEMENT; }
  if (parses_cleanly(code, length, "\nend")) { return INDENTED_RUBY_OPENS_END; }
  if (parses_cleanly(code, length, "\n}")) { return INDENTED_RUBY_OPENS_BRACE; }

  // `case x` on its own is not valid Ruby even when closed; its `when`/`in` branches follow as siblings.
  if (starts_with_keyword(code, length, "case")) { return INDENTED_RUBY_OPENS_END; }

  return INDENTED_RUBY_INVALID;
}
