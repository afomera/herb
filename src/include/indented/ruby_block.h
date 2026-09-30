#ifndef HERB_INDENTED_RUBY_BLOCK_H
#define HERB_INDENTED_RUBY_BLOCK_H

// Classifies a line of Ruby code from an indentation-based template (Slim `-`/`=`, Haml `-`/`=`),
// to decide whether the template language implies a closing `end` (or `}`) after the indented
// content, and whether the line continues a previous block (`else`, `when`, `rescue`, ...).

#include <stdbool.h>
#include <stddef.h>

typedef enum {
  INDENTED_RUBY_STATEMENT,    // complete code, nothing to close
  INDENTED_RUBY_OPENS_END,    // opens a construct closed by `end` (if, unless, case, while, `do |x|`, ...)
  INDENTED_RUBY_OPENS_BRACE,  // opens a `{ |x|` block closed by `}`
  INDENTED_RUBY_CONTINUATION, // else, elsif, when, in, rescue, ensure
  INDENTED_RUBY_END,          // an explicit `end`
  INDENTED_RUBY_CLOSE_BRACE,  // an explicit `}` closing a brace block
  INDENTED_RUBY_INVALID,      // not valid Ruby, even when closed
} indented_ruby_kind_T;

indented_ruby_kind_T indented_ruby_classify(const char* code, size_t length);

#endif
