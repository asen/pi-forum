import { ForumError } from './records.mjs'

/** @import { CursorData } from './cursor.d.mts' */

// Cursors are opaque to callers: base64url JSON { v: 1, forum, offset }, where forum is the
// SHA-256 of the forum's real directory and offset is a byte position after a complete line.
/**
 * @param {string} forumId
 * @param {number} offset
 * @returns {string}
 */
export function encodeCursor(forumId, offset) {
  /** @type {CursorData} */
  const data = { v: 1, forum: forumId, offset }
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

/**
 * @param {string} message
 * @returns {ForumError}
 */
function invalid(message) {
  return new ForumError('INVALID_CURSOR', message)
}

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
const isObject = (value) => value !== null && typeof value === 'object'

// Returns the cursor's byte offset after checking it against this forum and a log snapshot of size
// bytes; byteAt(position) resolves to one byte of that snapshot.
/**
 * @param {string} cursor
 * @param {string} forumId
 * @param {number} size
 * @param {(position: number) => Promise<number | undefined>} byteAt
 * @returns {Promise<number>}
 */
export async function decodeCursor(cursor, forumId, size, byteAt) {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid('cursor is not valid')
  /** @type {unknown} */
  let value
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw invalid('cursor is not valid')
  }
  if (!isObject(value) || value.v !== 1) throw invalid('cursor version is not supported')
  if (value.forum !== forumId) throw invalid('cursor belongs to a different forum')
  const { offset } = value
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    throw invalid('cursor position is outside the forum log')
  }
  if (offset > 0 && (await byteAt(offset - 1)) !== 0x0a) throw invalid('cursor position is not at a record boundary')
  return offset
}
