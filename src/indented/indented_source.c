#include "../include/indented/indented_source.h"
#include "../include/lib/hb_allocator.h"
#include "../include/util/utf8.h"

#include <string.h>

bool indented_is_space(char character) {
  return character == ' ' || character == '\t';
}

static uint32_t compute_indent(const char* source, uint32_t start, uint32_t end, uint32_t tab_size) {
  uint32_t width = 0;

  for (uint32_t index = start; index < end; index++) {
    if (source[index] == ' ') {
      width++;
    } else if (source[index] == '\t') {
      width = tab_size > 1 ? ((width / tab_size) + 1) * tab_size : width + 1;
    } else {
      break;
    }
  }

  return width;
}

bool indented_source_init(
  indented_source_T* indented,
  const char* source,
  uint32_t tab_size,
  hb_allocator_T* allocator
) {
  memset(indented, 0, sizeof(indented_source_T));

  indented->source = source ? source : "";
  indented->length = (uint32_t) strlen(indented->source);
  indented->allocator = allocator;

  size_t capacity = 1;

  for (uint32_t index = 0; index < indented->length; index++) {
    if (indented->source[index] == '\n') { capacity++; }
  }

  indented->lines = hb_allocator_alloc(allocator, sizeof(indented_line_T) * capacity);
  if (!indented->lines) { return false; }

  uint32_t line_start = 0;

  // Skip a leading UTF-8 byte order mark.
  if (indented->length >= 3 && (unsigned char) indented->source[0] == 0xEF
      && (unsigned char) indented->source[1] == 0xBB && (unsigned char) indented->source[2] == 0xBF) {
    line_start = 3;
  }

  while (line_start < indented->length) {
    uint32_t line_end = line_start;

    while (line_end < indented->length && indented->source[line_end] != '\n') {
      line_end++;
    }

    uint32_t next_start = line_end < indented->length ? line_end + 1 : line_end;

    if (line_end > line_start && indented->source[line_end - 1] == '\r') { line_end--; }

    indented_line_T* line = &indented->lines[indented->line_count++];
    line->start = line_start;
    line->end = line_end;
    line->content_start = line_start;

    while (line->content_start < line_end && indented_is_space(indented->source[line->content_start])) {
      line->content_start++;
    }

    line->content_end = line_end;

    while (
      line->content_end > line->content_start
      && (indented_is_space(indented->source[line->content_end - 1]) || indented->source[line->content_end - 1] == '\r')
    ) {
      line->content_end--;
    }

    line->blank = line->content_start == line->content_end;
    line->indent = compute_indent(indented->source, line_start, line_end, tab_size);

    line_start = next_start;
  }

  return true;
}

void indented_source_free(indented_source_T* indented) {
  if (!indented || !indented->lines) { return; }

  hb_allocator_dealloc(indented->allocator, indented->lines);
  indented->lines = NULL;
  indented->line_count = 0;
}

size_t indented_source_line_index_at(const indented_source_T* indented, uint32_t offset) {
  if (indented->line_count == 0) { return 0; }

  size_t low = 0;
  size_t high = indented->line_count - 1;

  while (low < high) {
    size_t middle = low + (high - low + 1) / 2;

    if (indented->lines[middle].start <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return low;
}

position_T indented_source_position(const indented_source_T* indented, uint32_t offset) {
  if (indented->line_count == 0) { return (position_T) { .line = 1, .column = 0 }; }

  if (offset > indented->length) { offset = indented->length; }

  size_t index = indented_source_line_index_at(indented, offset);
  const indented_line_T* line = &indented->lines[index];

  uint32_t column = 0;

  for (uint32_t cursor = line->start; cursor < offset && cursor < indented->length; cursor++) {
    if (indented->source[cursor] == '\n') { break; }
    if (!utf8_is_valid_continuation_byte((unsigned char) indented->source[cursor])) { column++; }
  }

  return (position_T) { .line = (uint32_t) index + 1, .column = column };
}
