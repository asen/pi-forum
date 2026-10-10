import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep, setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { decodeCursor, encodeCursor } from '../cursor.mjs'
import { ForumError, canonicalEvent, errorMessage, throwIfAborted } from '../records.mjs'

/**
 * @import { FileHandle } from 'node:fs/promises'
 * @import {
 *   EventVisitor,
 *   ForumAdapter,
 *   ForumEvent,
 *   ForumStore,
 *   OpenOptions,
 *   StoreReadOptions,
 *   StoreWriteOptions,
 *   WarningHandler,
 *   WriteTransaction,
 * } from '../types.d.mts'
 */

// One append-only events.jsonl log per forum directory. Each line is a flattened
// { type, ...fields } event; cursors are byte offsets after complete lines (see cursor.mjs).
//
// Reads take no lock. Each read covers the log's size when it was opened, in CHUNK_BYTES reads,
// yielding to the event loop and checking for cancellation after every chunk. Only one record is
// held at a time, up to MAX_RECORD_BYTES: far above any record valid input produces (a 64 KiB body
// and 256-character labels, even with every character JSON-escaped to 6 bytes, stay under 512 KiB).

const LOG_FILE = 'events.jsonl'
const LOCK_DIR = '.write-lock'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 2000
const NEWLINE = 0x0a
const CHUNK_BYTES = 64 * 1024
const MAX_RECORD_BYTES = 1024 * 1024

// The paths of an opened forum; id is the SHA-256 of its real directory dir.
/**
 * @typedef {object} ForumPaths
 * @property {string} dir
 * @property {string} id
 * @property {string} log
 * @property {string} lock
 */

// Turns an I/O failure into the error to throw.
/** @typedef {(err: unknown) => unknown} WrapError */

// A snapshot of the log, with size fixed when it is opened. A missing log is an empty snapshot
// without a handle.
/**
 * @typedef {{ file: string, wrap: WrapError } & (
 *   | { handle: FileHandle, size: number }
 *   | { handle: null, size: 0 }
 * )} LogSnapshot
 */

/** @typedef {Pick<StoreReadOptions, 'onWarning' | 'signal'>} ScanOptions */

// The code of a Node.js system error, if err is one.
/**
 * @param {unknown} err
 * @returns {unknown}
 */
const errorCode = (err) => (typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined)

/**
 * @param {ForumEvent} event
 * @returns {string}
 */
function encodeEvent({ type, data }) {
  return `${JSON.stringify({ type, ...data })}\n`
}

/**
 * @param {string} forumDir
 * @param {unknown} cause
 * @returns {ForumError}
 */
function unavailable(forumDir, cause) {
  return new ForumError('FORUM_UNAVAILABLE', `forum directory ${forumDir} is unavailable: ${errorMessage(cause)}`, { cause })
}

// Resolves the forum's real directory, which identifies it. Without create nothing is created and
// any failure to reach a directory is FORUM_UNAVAILABLE; with create, failures are thrown as is.
/**
 * @param {string} forumDir
 * @param {boolean} create
 * @returns {Promise<ForumPaths>}
 */
async function openForum(forumDir, create) {
  if (create) await fs.mkdir(forumDir, { recursive: true })
  /** @type {string} */
  let dir
  try {
    dir = await fs.realpath(forumDir)
    if (!create && !(await fs.stat(dir)).isDirectory()) {
      throw Object.assign(new Error(`${dir} is not a directory`), { code: 'ENOTDIR' })
    }
  } catch (err) {
    throw create ? err : unavailable(forumDir, err)
  }
  return {
    dir,
    id: createHash('sha256').update(dir).digest('hex'),
    log: path.join(dir, LOG_FILE),
    lock: path.join(dir, LOCK_DIR),
  }
}

// Runs fn(log) on a snapshot of the log. I/O failures are passed through wrap.
/**
 * @template T
 * @param {string} file
 * @param {WrapError} wrap
 * @param {(log: LogSnapshot) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLog(file, wrap, fn) {
  /** @type {FileHandle} */
  let handle
  try {
    handle = await fs.open(file, 'r')
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return fn({ file, handle: null, size: 0, wrap })
    throw wrap(err)
  }
  try {
    /** @type {number} */
    let size
    try {
      ;({ size } = await handle.stat())
    } catch (err) {
      throw wrap(err)
    }
    return await fn({ file, handle, size, wrap })
  } finally {
    // Closing a read-only descriptor cannot lose data, and must not replace the outcome.
    await handle.close().catch(() => {})
  }
}

// Reads exactly length snapshot bytes at position into buffer; a short read means the log shrank.
/**
 * @param {LogSnapshot} log
 * @param {Buffer} buffer
 * @param {number} length
 * @param {number} position
 * @returns {Promise<Buffer>}
 */
async function readAt(log, buffer, length, position) {
  let filled = 0
  while (filled < length) {
    // A missing log has no bytes to read.
    let bytesRead = 0
    if (log.handle !== null) {
      try {
        ;({ bytesRead } = await log.handle.read(buffer, filled, length - filled, position + filled))
      } catch (err) {
        throw log.wrap(err)
      }
    }
    if (bytesRead === 0) {
      throw log.wrap(
        new Error(`${log.file} ended at byte ${position + filled} while reading its first ${log.size} bytes; it was truncated`),
      )
    }
    filled += bytesRead
  }
  return buffer.subarray(0, length)
}

/**
 * @param {LogSnapshot} log
 * @param {number} position
 * @returns {Promise<number | undefined>}
 */
const byteAt = async (log, position) => (await readAt(log, Buffer.alloc(1), 1, position))[0]

// Calls visit(event) for each valid complete line from start until it returns true, warning about
// skipped records. Returns the offset after the last line consumed. Lines are decoded whole, so
// characters split across chunks are intact.
/**
 * @param {LogSnapshot} log
 * @param {number} start
 * @param {ScanOptions} options
 * @param {EventVisitor} visit
 * @returns {Promise<number>}
 */
async function scan(log, start, { onWarning, signal }, visit) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  let lineStart = start
  // Bytes of the line being completed, dropped once it is known to be oversized.
  /** @type {Buffer[]} */
  let parts = []
  let length = 0
  let oversized = false
  for (let position = start; position < log.size; ) {
    throwIfAborted(signal)
    const chunk = await readAt(log, buffer, Math.min(CHUNK_BYTES, log.size - position), position)
    throwIfAborted(signal)
    let from = 0
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, from)) {
      const offset = lineStart
      lineStart = position + end + 1
      /** @type {ForumEvent | null} */
      let event = null
      if (oversized || length + end - from > MAX_RECORD_BYTES) {
        onWarning(`skipping malformed record at byte offset ${offset}: record is larger than ${MAX_RECORD_BYTES} bytes`)
      } else {
        try {
          const piece = chunk.subarray(from, end)
          const line = parts.length === 0 ? piece : Buffer.concat([...parts, piece])
          event = canonicalEvent(JSON.parse(decoder.decode(line)))
        } catch (err) {
          onWarning(`skipping malformed record at byte offset ${offset}: ${errorMessage(err)}`)
        }
      }
      parts = []
      length = 0
      oversized = false
      from = end + 1
      if (event && visit(event)) return lineStart
    }
    if (!oversized && from < chunk.length) {
      length += chunk.length - from
      // The chunk buffer is reused, so a carried part is copied.
      if (length > MAX_RECORD_BYTES) {
        parts = []
        oversized = true
      } else {
        parts.push(Buffer.from(chunk.subarray(from)))
      }
    }
    position += chunk.length
    await yieldToEventLoop()
  }
  throwIfAborted(signal)
  if (lineStart < log.size) onWarning(`ignoring incomplete record at byte offset ${lineStart}`)
  return lineStart
}

// Returns the offset after the snapshot's last newline, searching back from the end in chunks.
/**
 * @param {LogSnapshot} log
 * @returns {Promise<number>}
 */
async function lastLineStart(log) {
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
  for (let end = log.size; end > 0; ) {
    const start = Math.max(0, end - CHUNK_BYTES)
    const index = (await readAt(log, buffer, end - start, start)).lastIndexOf(NEWLINE)
    if (index !== -1) return start + index + 1
    end = start
    await yieldToEventLoop()
  }
  return 0
}

// Stale locks are never removed automatically; the caller gets a bounded failure instead.
// If the write fails and releasing the lock fails too, the write failure is thrown and the
// release failure becomes a warning.
/**
 * @template T
 * @param {ForumPaths} forum
 * @param {WarningHandler} onWarning
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock(forum, onWarning, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await fs.mkdir(forum.lock)
      break
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err
      if (Date.now() >= deadline) {
        throw new ForumError(
          'LOCK_TIMEOUT',
          `timed out waiting for ${forum.lock}; if no pi-forum write is running, remove it manually`,
        )
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  /** @type {T} */
  let result
  try {
    result = await fn()
  } catch (err) {
    await fs.rmdir(forum.lock).catch((/** @type {unknown} */ lockErr) => {
      // A failing warning reporter must not replace the write failure.
      try {
        onWarning(
          `could not remove ${forum.lock} after a failed write: ${lockErr == null ? undefined : errorMessage(lockErr)}; ` +
            'if no pi-forum write is running, remove it manually',
        )
      } catch {}
    })
    throw err
  }
  await fs.rmdir(forum.lock)
  return result
}

// Refuses to append after an incomplete last line of the log snapshot.
/**
 * @param {LogSnapshot} log
 * @returns {Promise<void>}
 */
async function checkComplete(log) {
  if (log.size > 0 && (await byteAt(log, log.size - 1)) !== NEWLINE) {
    throw new ForumError(
      'INCOMPLETE_LOG',
      `${log.file} ends with an incomplete record at byte offset ${await lastLineStart(log)}; ` +
        'repair it manually before writing',
    )
  }
}

/**
 * @param {ForumPaths} forum
 * @param {ForumEvent} event
 * @returns {Promise<void>}
 */
async function append(forum, event) {
  try {
    await fs.appendFile(forum.log, encodeEvent(event))
  } catch (err) {
    throw new ForumError('WRITE_FAILED', `failed to append to ${forum.log}: ${errorMessage(err)}`, { cause: err })
  }
}

// A store's identity is the forum's real directory. Given the identity a client pinned earlier,
// open refuses a path that now resolves elsewhere, e.g. through a retargeted symlink.
/** @type {ForumAdapter} */
export const jsonlAdapter = {
  /**
   * @param {OpenOptions} options
   * @returns {Promise<ForumStore>}
   */
  async open({ forumDir, create, identity }) {
    const forum = await openForum(forumDir, create)
    if (identity !== undefined && forum.dir !== identity) {
      throw new ForumError(
        'FORUM_UNAVAILABLE',
        `forum directory ${forumDir} now resolves to ${forum.dir}, not ${identity}; select the forum again to use it`,
      )
    }
    return {
      identity: forum.dir,
      /**
       * @param {StoreReadOptions} options
       * @param {EventVisitor} visit
       * @returns {Promise<string>}
       */
      async read({ after, onWarning, signal }, visit) {
        throwIfAborted(signal)
        /** @type {WrapError} */
        const wrap = create ? (err) => err : (err) => unavailable(forumDir, err)
        return withLog(forum.log, wrap, async (log) => {
          const start = after == null ? 0 : await decodeCursor(after, forum.id, log.size, (p) => byteAt(log, p))
          return encodeCursor(forum.id, await scan(log, start, { onWarning, signal }, visit))
        })
      },
      // Writers check and scan one snapshot of the log, taken under the lock.
      /**
       * @template T
       * @param {StoreWriteOptions} options
       * @param {(transaction: WriteTransaction) => Promise<T>} fn
       * @returns {Promise<T>}
       */
      write({ onWarning }, fn) {
        return withLock(forum, onWarning, () =>
          withLog(forum.log, (err) => err, async (log) => {
            await checkComplete(log)
            return fn({
              read: async (visit) => {
                await scan(log, 0, { onWarning }, visit)
              },
              append: (event) => append(forum, event),
            })
          }),
        )
      },
    }
  },
}
