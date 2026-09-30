#ifndef HERB_ANALYZE_RUBY_PROGRAM_H
#define HERB_ANALYZE_RUBY_PROGRAM_H

// The Ruby code of a document, assembled in document order by a frontend whose source text is not
// HTML+ERB (for example an indentation-based template language), so it can't be re-extracted from the
// source with `herb_extract_ruby`. Analysis uses it instead of the source text for the passes that need
// the whole document as one Ruby program: document-wide Ruby parse errors, and resolving local variables
// for ActionView tag helpers.

#include "../ast/ast_nodes.h"
#include "../lib/hb_allocator.h"
#include "../lib/hb_array.h"
#include "../location/position.h"
#include "../parser/parser_options.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct HERB_RUBY_SEGMENT_STRUCT {
  uint32_t program_from; // byte range of the code in `herb_ruby_program_T.value`
  uint32_t program_to;
  uint32_t source_from; // byte range of the code in the template source (empty for implied code, e.g. an `end`)
  uint32_t source_to;
  position_T start; // location reported for Ruby parse errors in this segment
  position_T end;
} herb_ruby_segment_T;

typedef struct HERB_RUBY_PROGRAM_STRUCT {
  const char* value;
  size_t length;
  hb_array_T* segments; // herb_ruby_segment_T*, ordered by program offset
} herb_ruby_program_T;

// Maps a byte range of the template source to the matching byte range of the program.
bool herb_ruby_program_map_source_range(const herb_ruby_program_T* program, size_t* from, size_t* to);

void herb_analyze_parse_errors_from_ruby_program(
  AST_DOCUMENT_NODE_T* document,
  const herb_ruby_program_T* program,
  const parser_options_T* options,
  hb_allocator_T* allocator
);

#endif
