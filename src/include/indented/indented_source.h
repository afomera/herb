#ifndef HERB_INDENTED_SOURCE_H
#define HERB_INDENTED_SOURCE_H

// Line and indentation bookkeeping shared by the indentation-based template
// frontends (Slim, and later Haml). The source is split into lines once; each
// line records its byte offsets and its indentation width so the frontends can
// walk the template line by line while still producing exact source positions.

#include "../lib/hb_allocator.h"
#include "../location/position.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct INDENTED_LINE_STRUCT {
  uint32_t start;         // byte offset of the first character of the line
  uint32_t end;           // byte offset of the end of the line (excluding "\n" / "\r\n")
  uint32_t content_start; // byte offset of the first non-indentation character (== end for blank lines)
  uint32_t content_end;   // byte offset after the last non-whitespace character
  uint32_t indent;        // indentation width, with tabs expanded
  bool blank;
} indented_line_T;

typedef struct INDENTED_SOURCE_STRUCT {
  const char* source;
  uint32_t length;
  indented_line_T* lines;
  size_t line_count;
  hb_allocator_T* allocator;
} indented_source_T;

bool indented_source_init(
  indented_source_T* indented,
  const char* source,
  uint32_t tab_size,
  hb_allocator_T* allocator
);
void indented_source_free(indented_source_T* indented);

size_t indented_source_line_index_at(const indented_source_T* indented, uint32_t offset);
position_T indented_source_position(const indented_source_T* indented, uint32_t offset);

bool indented_is_space(char character);

#endif
