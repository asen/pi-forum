import { ForumError } from './records.js'

// Cursors are opaque to callers: base64url JSON { v: 1, forum, offset }, where forum is the
// SHA-256 of the forum's real directory and offset is a byte position after a complete line.
export interface CursorData {
  v: 1
  forum: string
  offset: number
}

export function encodeCursor(forumId: string, offset: number): string {
  const data: CursorData = { v: 1, forum: forumId, offset }
  return Buffer.from(JSON.stringify(data)).toString('base64url')
}

function invalid(message: string): ForumError {
  return new ForumError('INVALID_CURSOR', message)
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object'

// Returns the cursor's byte offset after checking it against this forum and a log snapshot of size
// bytes; byteAt(position) resolves to one byte of that snapshot.
export async function decodeCursor(
  cursor: string,
  forumId: string,
  size: number,
  byteAt: (position: number) => Promise<number | undefined>,
): Promise<number> {
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid('cursor is not valid')
  let value: unknown
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
