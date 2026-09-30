#ifndef HERB_SLIM_PARSER_H
#define HERB_SLIM_PARSER_H

// Slim frontend: parses a Slim template into a Herb DocumentNode made of the regular
// HTML+ERB node types (HTMLElementNode, HTMLTextNode, ERBContentNode, ...), so that the
// tree can be analyzed (`herb_analyze_parse_tree`) and printed as the equivalent HTML+ERB.
//
// Control code (`- if x`) is emitted as flat ERB nodes followed by the indented content and
// a synthetic `<% end %>` where Slim implies one; the analyzer then groups them into
// ERBIfNode, ERBBlockNode, ... exactly like it does for ERB templates.

#include "../ast/ast_nodes.h"
#include "../lib/hb_allocator.h"
#include "../parser/parser_options.h"

AST_DOCUMENT_NODE_T* herb_slim_parse(const char* source, const parser_options_T* options, hb_allocator_T* allocator);

#endif
