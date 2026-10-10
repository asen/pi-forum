import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ForumError } from '../src/records.mjs'
import {
  MAX_QUERY_BYTES,
  MAX_QUERY_DEPTH,
  MAX_QUERY_TERMS,
  MAX_QUERY_TOKENS,
  compileSearchQuery,
} from '../src/search-query.mjs'

// A query and the texts it must and must not match.
type Case = [query: string, matches: string[], misses: string[]]

const check = (cases: Case[]) => {
  for (const [query, matches, misses] of cases) {
    const predicate = compileSearchQuery(query)
    for (const text of matches) assert.equal(predicate(text), true, `${JSON.stringify(query)} matches ${JSON.stringify(text)}`)
    for (const text of misses) assert.equal(predicate(text), false, `${JSON.stringify(query)} misses ${JSON.stringify(text)}`)
  }
}

const rejects = (query: unknown, message: string) => {
  assert.throws(
    () => compileSearchQuery(query as string),
    (err: unknown) => err instanceof ForumError && err.code === 'INVALID_INPUT' && err.message === message,
    `${JSON.stringify(query)} is rejected with ${message}`,
  )
}

const at = (problem: string, offset: number) => `search query ${problem} at offset ${offset}`
const EXPECTS = 'expects a term, phrase or group'
const TOO_LONG = `search query must be at most ${MAX_QUERY_BYTES} bytes of UTF-8`
const TOO_MANY_TOKENS = `search query must have at most ${MAX_QUERY_TOKENS} tokens`
const TOO_MANY_TERMS = `search query must have at most ${MAX_QUERY_TERMS} terms`

describe('search query matching', () => {
  test('terms match case-insensitive literal substrings', () => {
    check([
      ['foo', ['foo', 'FOO', 'a Foobar b'], ['fo', 'f oo', '']],
      ['FoO', ['foo', 'xFOOx'], ['bar']],
    ])
  })

  test('precedence is NOT, then AND, then OR', () => {
    check([
      ['a OR b AND c', ['a', 'bc'], ['b', 'c', 'x']],
      ['a AND b OR c', ['ab', 'c'], ['a', 'b', 'x']],
      ['a OR b c', ['a', 'bc'], ['b', 'c']],
      ['NOT a AND b', ['b'], ['ab', 'x']],
      ['NOT a OR b', ['x', 'ab', 'b'], ['a']],
      ['NOT (a OR b)', ['x'], ['a', 'b']],
      ['(a OR b) AND c', ['ac', 'bc'], ['ab', 'c']],
      ['a OR (b OR c) d', ['a', 'bd', 'cd'], ['b', 'd']],
    ])
  })

  test('adjacent operands imply AND', () => {
    check([
      ['foo bar', ['foo bar', 'bar foo'], ['foo', 'bar']],
      ['foo NOT bar', ['foo'], ['foo bar', 'bar']],
      ['foo AND NOT bar', ['foo'], ['foo bar']],
      ['(a OR b)(c OR d)', ['ac', 'bd'], ['ab', 'cd']],
      ['(a OR b) (c OR d)', ['ad', 'bc'], ['a', 'c']],
      ['foo"bar"', ['bar foo'], ['foo']],
      ['"a""b"', ['b a'], ['a']],
      ['a(b)c', ['abc', 'c b a'], ['ab']],
      ['foo NOT NOT bar', ['foo bar'], ['foo']],
    ])
  })

  test('whole unquoted AND, OR and NOT are operators in any ASCII case', () => {
    check([
      ['a and b', ['ab'], ['a', 'and']],
      ['a And b', ['ab'], ['a']],
      ['a or b', ['a', 'b'], ['or']],
      ['a oR b', ['b'], ['x']],
      ['not a', ['b', 'not'], ['a', 'not a']],
      ['nOt a', ['b'], ['a']],
    ])
  })

  test('quoted and partial reserved words are literal terms', () => {
    check([
      ['"AND"', ['sand', 'AND'], ['an d']],
      ['"or" "not"', ['for nothing'], ['for', 'nothing']],
      ['"NOT" a', ['not a'], ['a']],
      ['ANDROID', ['android'], ['and']],
      ['a ORb', ['a orb'], ['a', 'b']],
      ['NOTE', ['note'], ['x']],
      ['AND_', ['and_'], ['and']],
      ['ＡＮＤ', ['ａｎｄ'], ['and']],
    ])
  })

  test('phrases preserve their content and decode only \\" and \\\\', () => {
    check([
      ['"foo  bar"', ['a foo  bar b'], ['foo bar', 'foo']],
      ['" a "', ['x a y'], ['a', 'xay']],
      ['"say \\"hi\\""', ['they say "HI"'], ['say hi', 'say \\"hi\\"']],
      ['"a\\\\b"', ['a\\b'], ['a\\\\b', 'ab']],
      ['"\\\\"', ['\\'], ['x']],
      ['"\\\\\\""', ['\\"'], ['\\', '"']],
      ['"a\\nb"', ['a\\nb'], ['a\nb', 'anb']],
      ['"\\x"', ['\\x'], ['x']],
      ['"a OR b"', ['a or b'], ['a', 'b']],
      ['"(a)"', ['(a)'], ['a']],
      ['"it\'s"', ["it's"], ['its']],
    ])
  })

  test('backslashes outside phrases and single quotes are literal', () => {
    check([
      ['C:\\path', ['c:\\PATH\\x'], ['c:path']],
      ['foo\\', ['foo\\'], ['foo']],
      ['\\"bar"', ['\\ bar'], ['bar', '\\']],
      ['a\\"b"', ['a\\ b'], ['ab', 'a b']],
      ["'foo bar'", ["'foo bar'", "bar' 'foo"], ['foo bar']],
      ["it's", ["IT'S"], ['its']],
    ])
  })

  test('punctuation and pattern metacharacters are literal', () => {
    check([
      ['a.b', ['a.b'], ['axb', 'ab']],
      ['.*', ['x.*y'], ['abc', '']],
      ['foo*', ['foo*'], ['foobar']],
      ['a|b', ['a|b'], ['a', 'b']],
      ['a&&b', ['a&&b'], ['a b']],
      ['-foo', ['-foo'], ['bar', 'foo']],
      ['+foo', ['+foo'], ['foo']],
      ['[x]', ['[x]'], ['x']],
      ['^foo$', ['^foo$'], ['foo']],
      ['a?', ['a?'], ['a']],
      ['{1,2}', ['{1,2}'], ['1']],
      ['a+b', ['a+b'], ['aab']],
      ['%_', ['%_'], ['a']],
      ['#tag @name', ['@name #tag'], ['tag name']],
      ['$&', ['$&'], ['']],
    ])
  })

  test('Unicode matches through toLowerCase alone', () => {
    check([
      ['ÄÖÜ', ['äöü', 'ÄÖÜ'], ['aou']],
      ['日本', ['日本語'], ['日']],
      ['🧪', ['tests 🧪'], ['tests']],
      ['"🧪 tests"', ['🧪 TESTS'], ['tests 🧪']],
      ['straße', ['STRAßE'], ['strasse', 'STRASSE']],
      // No normalization: precomposed é and e with a combining acute accent are different texts.
      ['é', ['É'], ['e\u0301']],
      ['e\u0301', ['E\u0301'], ['é']],
      // No locale: I lowercases to i, never to the Turkish dotless ı.
      ['I', ['i'], ['ı']],
      ['İ', ['i\u0307', 'İstanbul'], ['i', 'I']],
      // toLowerCase() maps a word-final capital sigma to ς, and a lone one to σ.
      ['Σ', ['σ', 'ΣΑ'], ['ΟΔΟΣ']],
      ['ΟΔΟΣ', ['οδος', 'ΟΔΟΣ'], ['οδοσ']],
      // Whitespace is JavaScript's, so a no-break space separates terms.
      ['foo\u00a0bar', ['bar foo'], ['foo']],
    ])
  })

  test('negative-only queries are valid', () => {
    check([
      ['NOT foo', ['', 'bar'], ['foo', 'FOO']],
      ['NOT foo NOT bar', ['', 'baz'], ['foo', 'bar']],
      ['NOT (foo OR bar)', ['baz'], ['foo', 'bar']],
      ['NOT foo OR NOT bar', ['foo', 'bar', ''], ['foo bar']],
      ['NOT NOT foo', ['foo'], ['', 'bar']],
    ])
  })

  test('a predicate lowercases each text once and short-circuits', (t) => {
    const predicate = compileSearchQuery('a b OR c NOT d OR NOT (e f)')
    const lower = t.mock.method(String.prototype, 'toLowerCase')
    const includes = t.mock.method(String.prototype, 'includes')
    const results = [predicate('A B'), predicate('C'), predicate('x')]
    const lowered = lower.mock.callCount()
    const searched = includes.mock.calls.map((call) => call.arguments[0])
    lower.mock.restore()
    includes.mock.restore()
    assert.deepEqual(results, [true, true, true])
    assert.equal(lowered, 3)
    // 'a b' stops after a and b; 'c' fails a, then matches c and checks d; 'x' fails a, c and e.
    assert.deepEqual(searched, ['a', 'b', 'a', 'c', 'd', 'a', 'c', 'e'])
  })
})

describe('search query rejections', () => {
  test('non-string queries', () => {
    for (const query of [undefined, null, 42, true, {}, ['foo'], new String('foo'), Symbol('foo')]) {
      rejects(query, 'search query must be a string')
    }
  })

  test('empty and blank queries', () => {
    for (const query of ['', ' ', '\t\n', '\u00a0\u2003']) rejects(query, 'search query must not be empty')
  })

  test('malformed Unicode', () => {
    for (const query of ['\ud800', 'foo \udc00', '"\ud83d"', 'a\ud83d', '\udfff\ud800']) {
      rejects(query, 'search query must be well-formed Unicode text')
    }
  })

  test('syntax errors name their zero-based UTF-16 offsets', () => {
    const cases: [string, string, number][] = [
      ['foo AND', EXPECTS, 7],
      ['AND foo', EXPECTS, 0],
      ['OR', EXPECTS, 0],
      ['foo OR', EXPECTS, 6],
      ['foo OR OR bar', EXPECTS, 7],
      ['foo AND OR bar', EXPECTS, 8],
      ['foo AND AND bar', EXPECTS, 8],
      ['NOT', EXPECTS, 3],
      ['foo NOT', EXPECTS, 7],
      ['NOT AND foo', EXPECTS, 4],
      ['(', EXPECTS, 1],
      ['()', EXPECTS, 1],
      ['a (b OR) c', EXPECTS, 7],
      ['(AND a)', EXPECTS, 1],
      ['(foo', 'has an unclosed "("', 0],
      ['((a)', 'has an unclosed "("', 0],
      ['a (b (c)', 'has an unclosed "("', 2],
      ['foo)', 'has an unmatched ")"', 3],
      [')', 'has an unmatched ")"', 0],
      [') foo', 'has an unmatched ")"', 0],
      ['(a))', 'has an unmatched ")"', 3],
      ['"foo', 'has an unclosed quote', 0],
      ['a "foo\\"', 'has an unclosed quote', 2],
      ['a "foo\\', 'has an unclosed quote', 2],
      ['"a" "', 'has an unclosed quote', 4],
      ['""', 'has an empty phrase', 0],
      ['foo ""', 'has an empty phrase', 4],
      ['😀 AND', EXPECTS, 6],
      ['日本 "x', 'has an unclosed quote', 3],
      ['🧪)', 'has an unmatched ")"', 2],
    ]
    for (const [query, problem, offset] of cases) rejects(query, at(problem, offset))
  })
})

describe('search query bounds', () => {
  test(`at most ${MAX_QUERY_BYTES} bytes of UTF-8`, () => {
    check([
      ['a'.repeat(MAX_QUERY_BYTES), ['a'.repeat(MAX_QUERY_BYTES)], ['a']],
      ['é'.repeat(MAX_QUERY_BYTES / 2), ['É'.repeat(MAX_QUERY_BYTES / 2)], ['é']],
      ['😀'.repeat(MAX_QUERY_BYTES / 4), ['😀'.repeat(MAX_QUERY_BYTES / 4)], ['😀']],
      [' '.repeat(MAX_QUERY_BYTES - 1) + 'a', ['a'], ['b']],
    ])
    for (const query of [
      'a'.repeat(MAX_QUERY_BYTES + 1),
      ' '.repeat(MAX_QUERY_BYTES + 1),
      'é'.repeat(MAX_QUERY_BYTES / 2) + 'a',
      '😀'.repeat(MAX_QUERY_BYTES / 4) + 'a',
      'a'.repeat(1_000_000),
      // The length check comes first: a long malformed query is rejected for its length.
      '\ud800'.repeat(MAX_QUERY_BYTES + 1),
    ]) {
      rejects(query, TOO_LONG)
    }
  })

  test(`at most ${MAX_QUERY_TERMS} terms`, () => {
    const terms = (count: number, term: string, separator: string) => Array.from({ length: count }, () => term).join(separator)
    check([
      [terms(MAX_QUERY_TERMS, 'a', ' '), ['a'], ['b']],
      [terms(MAX_QUERY_TERMS, '"a"', ''), ['a'], ['b']],
      [terms(MAX_QUERY_TERMS, 'x', ' OR '), ['x'], ['y']],
    ])
    rejects(terms(MAX_QUERY_TERMS + 1, 'a', ' '), TOO_MANY_TERMS)
    rejects(terms(MAX_QUERY_TERMS + 1, '"a"', ''), TOO_MANY_TERMS)
    rejects(terms(MAX_QUERY_TERMS + 1, 'x', ' OR '), TOO_MANY_TERMS)
    // Reserved words do not count as terms; quoted ones do.
    rejects(terms(MAX_QUERY_TERMS + 1, '"AND"', ' '), TOO_MANY_TERMS)
  })

  test(`at most ${MAX_QUERY_TOKENS} tokens, including bounded NOT chains`, () => {
    // 64 groups of three tokens, joined by 63 ORs, is 255 tokens.
    const groups = Array.from({ length: MAX_QUERY_TERMS }, () => '(a)').join(' OR ')
    check([
      [`NOT ${groups}`, ['a', 'b'], []],
      ['NOT '.repeat(MAX_QUERY_TOKENS - 1) + 'a', ['b'], ['a']],
      ['NOT '.repeat(MAX_QUERY_TOKENS - 2) + 'a', ['a'], ['b']],
      ['(' + 'NOT '.repeat(MAX_QUERY_TOKENS - 3) + 'a)', ['b'], ['a']],
    ])
    rejects(`NOT NOT ${groups}`, TOO_MANY_TOKENS)
    rejects('NOT '.repeat(MAX_QUERY_TOKENS) + 'a', TOO_MANY_TOKENS)
    rejects('NOT '.repeat(MAX_QUERY_TOKENS + 1), TOO_MANY_TOKENS)
    rejects(')'.repeat(MAX_QUERY_TOKENS + 1), TOO_MANY_TOKENS)
  })

  test(`at most ${MAX_QUERY_DEPTH} nested groups`, () => {
    const nested = (depth: number) => '('.repeat(depth) + 'a' + ')'.repeat(depth)
    check([
      [nested(MAX_QUERY_DEPTH), ['a'], ['b']],
      [`${nested(MAX_QUERY_DEPTH)} ${nested(MAX_QUERY_DEPTH)}`, ['a'], ['b']],
      ['NOT ('.repeat(MAX_QUERY_DEPTH) + 'a' + ')'.repeat(MAX_QUERY_DEPTH), ['a'], ['b']],
    ])
    rejects(nested(MAX_QUERY_DEPTH + 1), at(`nests more than ${MAX_QUERY_DEPTH} groups`, MAX_QUERY_DEPTH))
    rejects(`x ${nested(MAX_QUERY_DEPTH + 1)}`, at(`nests more than ${MAX_QUERY_DEPTH} groups`, MAX_QUERY_DEPTH + 2))
  })
})
