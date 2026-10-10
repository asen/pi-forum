import { ForumError } from './records.mjs'

/** @import { SearchPredicate } from './search-query.d.mts' */

// Inclusive bounds on one query.
export const MAX_QUERY_BYTES = 4096
export const MAX_QUERY_TERMS = 64
export const MAX_QUERY_TOKENS = 256
export const MAX_QUERY_DEPTH = 16

// A query is terms combined by NOT, AND and OR, in that order of precedence; adjacent operands are
// joined by AND and parentheses group. A term is a bare word, ending at whitespace, a double quote
// or a parenthesis, or a double-quoted phrase, in which only \" and \\ are escapes. Whole unquoted
// AND, OR and NOT in any ASCII case are the operators; everything else is literal. A term matches
// text that contains it, both lowercased by toLowerCase(): no locale, normalization or patterns.

/**
 * @typedef {{ kind: 'term', start: number, text: string }
 *   | { kind: 'and' | 'or' | 'not' | 'open' | 'close', start: number }} Token
 */

/** @typedef {(lower: string) => boolean} Matcher */

const SPACE = /\s+/y
const BARE = /[^\s"()]+/y
const OPERATOR = /^(?:and|or|not)$/i

/**
 * @param {string} message
 * @returns {ForumError}
 */
function invalid(message) {
  return new ForumError('INVALID_INPUT', message)
}

/**
 * @param {string} problem
 * @param {number} offset
 * @returns {ForumError}
 */
function syntax(problem, offset) {
  return invalid(`search query ${problem} at offset ${offset}`)
}

// Decodes the phrase whose opening quote is at open; returns its text and the offset after it.
/**
 * @param {string} query
 * @param {number} open
 * @returns {{ text: string, end: number }}
 */
function phrase(query, open) {
  let text = ''
  for (let i = open + 1; i < query.length; i++) {
    const char = query.charAt(i)
    if (char === '"') {
      if (text === '') throw syntax('has an empty phrase', open)
      return { text, end: i + 1 }
    }
    if (char === '\\') {
      const escaped = query.charAt(i + 1)
      if (escaped === '"' || escaped === '\\') {
        text += escaped
        i++
        continue
      }
    }
    text += char
  }
  throw syntax('has an unclosed quote', open)
}

/**
 * @param {string} query
 * @returns {Token[]}
 */
function tokenize(query) {
  /** @type {Token[]} */
  const tokens = []
  let terms = 0
  /** @param {Token} token */
  const push = (token) => {
    if (tokens.length === MAX_QUERY_TOKENS) throw invalid(`search query must have at most ${MAX_QUERY_TOKENS} tokens`)
    if (token.kind === 'term' && ++terms > MAX_QUERY_TERMS) {
      throw invalid(`search query must have at most ${MAX_QUERY_TERMS} terms`)
    }
    tokens.push(token)
  }
  let i = 0
  while (i < query.length) {
    SPACE.lastIndex = i
    if (SPACE.test(query)) {
      i = SPACE.lastIndex
      continue
    }
    const char = query.charAt(i)
    if (char === '(' || char === ')') {
      push({ kind: char === '(' ? 'open' : 'close', start: i })
      i++
    } else if (char === '"') {
      const { text, end } = phrase(query, i)
      push({ kind: 'term', start: i, text: text.toLowerCase() })
      i = end
    } else {
      // Matches at least this character, which is neither whitespace, a quote nor a parenthesis.
      BARE.lastIndex = i
      BARE.test(query)
      const word = query.slice(i, BARE.lastIndex)
      if (OPERATOR.test(word)) {
        push({ kind: /** @type {'and' | 'or' | 'not'} */ (word.toLowerCase()), start: i })
      } else {
        push({ kind: 'term', start: i, text: word.toLowerCase() })
      }
      i += word.length
    }
  }
  return tokens
}

// Recursive descent over the tokens. Recursion deepens only by entering a group, which the depth
// bound limits; NOT chains are read in a loop and kept as their parity.
/**
 * @param {string} query
 * @param {Token[]} tokens
 * @returns {Matcher}
 */
function parse(query, tokens) {
  let next = 0
  let depth = 0

  /** @returns {Matcher} */
  function disjunction() {
    const operands = [conjunction()]
    while (tokens[next]?.kind === 'or') {
      next++
      operands.push(conjunction())
    }
    const [only] = operands
    return operands.length === 1 && only ? only : (lower) => operands.some((operand) => operand(lower))
  }

  /** @returns {Matcher} */
  function conjunction() {
    const operands = [negation()]
    for (;;) {
      const token = tokens[next]
      if (token === undefined || token.kind === 'or' || token.kind === 'close') break
      if (token.kind === 'and') next++
      operands.push(negation())
    }
    const [only] = operands
    return operands.length === 1 && only ? only : (lower) => operands.every((operand) => operand(lower))
  }

  /** @returns {Matcher} */
  function negation() {
    let negated = false
    while (tokens[next]?.kind === 'not') {
      negated = !negated
      next++
    }
    const operand = primary()
    return negated ? (lower) => !operand(lower) : operand
  }

  /** @returns {Matcher} */
  function primary() {
    const token = tokens[next]
    if (token?.kind === 'term') {
      next++
      const { text } = token
      return (lower) => lower.includes(text)
    }
    if (token?.kind === 'open') {
      if (depth === MAX_QUERY_DEPTH) throw syntax(`nests more than ${MAX_QUERY_DEPTH} groups`, token.start)
      depth++
      next++
      const inner = disjunction()
      if (tokens[next]?.kind !== 'close') throw syntax('has an unclosed "("', token.start)
      next++
      depth--
      return inner
    }
    if (token?.kind === 'close' && depth === 0) throw syntax('has an unmatched ")"', token.start)
    throw syntax('expects a term, phrase or group', token?.start ?? query.length)
  }

  const matcher = disjunction()
  // disjunction() stops only at the end or at a closing parenthesis, which no group opened.
  const extra = tokens[next]
  if (extra !== undefined) throw syntax('has an unmatched ")"', extra.start)
  return matcher
}

/**
 * @param {string} query
 * @returns {SearchPredicate}
 */
export function compileSearchQuery(query) {
  if (typeof query !== 'string') throw invalid('search query must be a string')
  // Every UTF-16 code unit takes at least one byte of UTF-8, so this cheap check bounds the work
  // of the checks after it.
  const tooLong = `search query must be at most ${MAX_QUERY_BYTES} bytes of UTF-8`
  if (query.length > MAX_QUERY_BYTES) throw invalid(tooLong)
  if (!query.isWellFormed()) throw invalid('search query must be well-formed Unicode text')
  if (Buffer.byteLength(query, 'utf8') > MAX_QUERY_BYTES) throw invalid(tooLong)
  const tokens = tokenize(query)
  if (tokens.length === 0) throw invalid('search query must not be empty')
  const matcher = parse(query, tokens)
  return (text) => matcher(text.toLowerCase())
}
