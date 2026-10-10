// Consumer contract of search-query.mjs: compiling a Boolean search query into a predicate.

// Inclusive bounds on one query.
export declare const MAX_QUERY_BYTES = 4096
export declare const MAX_QUERY_TERMS = 64
export declare const MAX_QUERY_TOKENS = 256
export declare const MAX_QUERY_DEPTH = 16

// Whether one text matches the compiled query.
export type SearchPredicate = (text: string) => boolean

// A query is terms combined by NOT, AND and OR, in that order of precedence; adjacent operands are
// joined by AND and parentheses group. A term is a bare word, ending at whitespace, a double quote
// or a parenthesis, or a double-quoted phrase, in which only \" and \\ are escapes. Whole unquoted
// AND, OR and NOT in any ASCII case are the operators; everything else is literal. A term matches
// text that contains it, both lowercased by toLowerCase(): no locale, normalization or patterns.
// Throws a ForumError INVALID_INPUT for a query that is not a string, is out of bounds, is not
// well-formed Unicode or has a syntax error, which names its zero-based UTF-16 offset.
export declare function compileSearchQuery(query: string): SearchPredicate
