import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { decodeCursor, encodeCursor } from './cursor.js'
import {
  ForumError,
  checkId,
  encodeEvent,
  messageInput,
  newMessage,
  newTopic,
  parseEvent,
  topicInput,
} from './records.js'

export { ForumError }

const LOG_FILE = 'events.jsonl'
const LOCK_DIR = '.write-lock'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 2000
const DEFAULT_TOPIC_LIMIT = 20
const DEFAULT_MESSAGE_LIMIT = 50
const MAX_LIMIT = 100
const NEWLINE = 0x0a

const defaultWarning = (message) => console.warn(`pi-forum: warning: ${message}`)

async function openForum(forumDir) {
  if (typeof forumDir !== 'string' || !path.isAbsolute(forumDir)) {
    throw new ForumError('INVALID_INPUT', 'forum directory must be an absolute path')
  }
  await fs.mkdir(forumDir, { recursive: true })
  const dir = await fs.realpath(forumDir)
  return {
    id: createHash('sha256').update(dir).digest('hex'),
    log: path.join(dir, LOG_FILE),
    lock: path.join(dir, LOCK_DIR),
  }
}

// Reads the log up to its size when opened; bytes appended later are left for the next read.
async function readLog(file) {
  let handle
  try {
    handle = await fs.open(file, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') return Buffer.alloc(0)
    throw err
  }
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(size)
    let length = 0
    while (length < size) {
      const { bytesRead } = await handle.read(buffer, length, size - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
}

// Yields { event, next } for each complete line from start; event is null for skipped records.
function* scan(log, start, onWarning) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let offset = start
  let end = log.indexOf(NEWLINE, offset)
  while (end !== -1) {
    let event = null
    try {
      event = parseEvent(decoder.decode(log.subarray(offset, end)))
    } catch (err) {
      onWarning(`skipping malformed record at byte offset ${offset}: ${err.message}`)
    }
    yield { event, next: end + 1 }
    offset = end + 1
    end = log.indexOf(NEWLINE, offset)
  }
  if (offset < log.length) onWarning(`ignoring incomplete record at byte offset ${offset}`)
}

function checkLimit(limit, defaultLimit) {
  if (limit == null) return defaultLimit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ForumError('INVALID_INPUT', `limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  return limit
}

async function list(forumDir, { after, limit, onWarning = defaultWarning }, defaultLimit, select) {
  limit = checkLimit(limit, defaultLimit)
  const forum = await openForum(forumDir)
  const log = await readLog(forum.log)
  let next = after == null ? 0 : decodeCursor(after, forum.id, log)
  const items = []
  for (const record of scan(log, next, onWarning)) {
    const item = record.event && select(record.event)
    if (item) items.push(item)
    next = record.next
    if (items.length === limit) break
  }
  return { items, next_cursor: encodeCursor(forum.id, next) }
}

export function listTopics(forumDir, options = {}) {
  return list(forumDir, options, DEFAULT_TOPIC_LIMIT, ({ type, data }) => type === 'topic_created' && data)
}

export function listMessages(forumDir, { topicId, ...options } = {}) {
  if (topicId != null) checkId(topicId, 'topicId')
  return list(
    forumDir,
    options,
    DEFAULT_MESSAGE_LIMIT,
    ({ type, data }) => type === 'message_posted' && (topicId == null || data.topic_id === topicId) && data,
  )
}

export async function getTopic(forumDir, topicId, { onWarning = defaultWarning } = {}) {
  checkId(topicId, 'topicId')
  const forum = await openForum(forumDir)
  for (const { event } of scan(await readLog(forum.log), 0, onWarning)) {
    if (event?.type === 'topic_created' && event.data.id === topicId) return event.data
  }
  throw new ForumError('NOT_FOUND', `topic ${topicId} not found`)
}

// Stale locks are never removed automatically; the caller gets a bounded failure instead.
// If the write fails and releasing the lock fails too, the write failure is thrown and the
// release failure becomes a warning.
async function withLock(forum, onWarning, fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      await fs.mkdir(forum.lock)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (Date.now() >= deadline) {
        throw new ForumError(
          'LOCK_TIMEOUT',
          `timed out waiting for ${forum.lock}; if no pi-forum write is running, remove it manually`,
        )
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
  let result
  try {
    result = await fn()
  } catch (err) {
    await fs.rmdir(forum.lock).catch((lockErr) => {
      // A failing warning reporter must not replace the write failure.
      try {
        onWarning(
          `could not remove ${forum.lock} after a failed write: ${lockErr?.message}; ` +
            'if no pi-forum write is running, remove it manually',
        )
      } catch {}
    })
    throw err
  }
  await fs.rmdir(forum.lock)
  return result
}

// Reads the log for a write, refusing to append after an incomplete last line.
async function readWritableLog(forum) {
  const log = await readLog(forum.log)
  if (log.length > 0 && log[log.length - 1] !== NEWLINE) {
    const offset = log.lastIndexOf(NEWLINE) + 1
    throw new ForumError(
      'INCOMPLETE_LOG',
      `${forum.log} ends with an incomplete record at byte offset ${offset}; repair it manually before writing`,
    )
  }
  return log
}

async function append(forum, type, data) {
  try {
    await fs.appendFile(forum.log, encodeEvent(type, data))
  } catch (err) {
    throw new ForumError('WRITE_FAILED', `failed to append to ${forum.log}: ${err.message}`, { cause: err })
  }
}

// Topic and initial message are two appends. If the second fails, the error carries the created topic.
export async function createTopic(forumDir, input) {
  const fields = topicInput(input)
  const forum = await openForum(forumDir)
  return withLock(forum, defaultWarning, async () => {
    await readWritableLog(forum)
    const topic = newTopic(fields)
    await append(forum, 'topic_created', topic)
    if (fields.body === undefined) return { topic, message: null }
    const message = newMessage({ ...fields, topicId: topic.id })
    try {
      await append(forum, 'message_posted', message)
    } catch (err) {
      const partial = new ForumError(
        'PARTIAL_WRITE',
        `topic ${topic.id} was created but its initial message was not appended: ${err.message}`,
        { cause: err },
      )
      partial.topic = topic
      throw partial
    }
    return { topic, message }
  })
}

export async function postMessage(forumDir, input, { onWarning = defaultWarning } = {}) {
  const fields = messageInput(input)
  const forum = await openForum(forumDir)
  return withLock(forum, onWarning, async () => {
    let topicFound = false
    let reply = null
    for (const { event } of scan(await readWritableLog(forum), 0, onWarning)) {
      if (event?.type === 'topic_created' && event.data.id === fields.topicId) topicFound = true
      if (event?.type === 'message_posted' && event.data.id === fields.replyTo) reply = event.data
    }
    if (!topicFound) throw new ForumError('NOT_FOUND', `topic ${fields.topicId} not found`)
    if (fields.replyTo !== undefined) {
      if (!reply) throw new ForumError('NOT_FOUND', `message ${fields.replyTo} not found`)
      if (reply.topic_id !== fields.topicId) {
        throw new ForumError('INVALID_INPUT', `message ${fields.replyTo} belongs to a different topic`)
      }
    }
    const message = newMessage(fields)
    await append(forum, 'message_posted', message)
    return message
  })
}
