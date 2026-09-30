#include "../include/analyze/ruby_program.h"
#include "../include/errors.h"
#include "../include/lib/hb_array.h"
#include "../include/parser/parser.h"
#include "../include/prism/prism_helpers.h"

#include <prism.h>

static const herb_ruby_segment_T* segment_at_program_offset(const herb_ruby_program_T* program, size_t offset) {
  const herb_ruby_segment_T* found = NULL;

  for (size_t index = 0; index < hb_array_size(program->segments); index++) {
    const herb_ruby_segment_T* segment = hb_array_get(program->segments, index);
    if (segment->program_from > offset) { break; }

    found = segment;
  }

  return found;
}

bool herb_ruby_program_map_source_range(const herb_ruby_program_T* program, size_t* from, size_t* to) {
  if (!program || !program->segments) { return false; }

  for (size_t index = 0; index < hb_array_size(program->segments); index++) {
    const herb_ruby_segment_T* segment = hb_array_get(program->segments, index);

    if (segment->source_from == segment->source_to) { continue; }
    if (*from < segment->source_from || *from >= segment->source_to) { continue; }

    size_t mapped_from = segment->program_from + (*from - segment->source_from);
    size_t mapped_to = segment->program_from + (*to - segment->source_from);

    if (mapped_to > segment->program_to) { mapped_to = segment->program_to; }

    *from = mapped_from;
    *to = mapped_to;

    return true;
  }

  return false;
}

void herb_analyze_parse_errors_from_ruby_program(
  AST_DOCUMENT_NODE_T* document,
  const herb_ruby_program_T* program,
  const parser_options_T* options,
  hb_allocator_T* allocator
) {
  if (!document || !program || !program->value || program->length == 0) { return; }
  if (!program->segments || hb_array_size(program->segments) == 0) { return; }

  pm_parser_t parser;
  pm_options_t prism_options = { 0, .partial_script = true };
  pm_parser_init(&parser, (const uint8_t*) program->value, program->length, &prism_options);

  pm_node_t* root = pm_parse(&parser);

  for (const pm_diagnostic_t* error = (const pm_diagnostic_t*) parser.error_list.head; error != NULL;
       error = (const pm_diagnostic_t*) error->node.next) {
    if (parser_options_errors_exceeded(options)) { break; }

    size_t offset = (size_t) (error->location.start - parser.start);
    const herb_ruby_segment_T* segment = segment_at_program_offset(program, offset);

    if (!segment) { segment = hb_array_first(program->segments); }

    RUBY_PARSE_ERROR_T* parse_error =
      ruby_parse_error_from_prism_error_with_positions(error, segment->start, segment->end, allocator);

    hb_array_append_lazy(&document->base.errors, parse_error, allocator);
  }

  pm_node_destroy(&parser, root);
  pm_parser_free(&parser);
  pm_options_free(&prism_options);
}
