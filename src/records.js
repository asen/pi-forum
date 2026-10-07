import { randomUUID } from 'node:crypto'

export const MAX_LABEL_CHARS = 256
export const MAX_BODY_BYTES = 64 * 1024

export class ForumError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ForumError'
    this.code = code
  }
}

function invalid(message) {
  return new ForumError('INVALID_INPUT', message)
}

function text(value, name, { maxChars, maxBytes }) {
  if (typeof value !== 'string' || value.trim() === '') throw invalid(`${name} must be a non-blank string`)
  if (!value.isWellFormed()) throw invalid(`${name} must be well-formed Unicode text`)
  if (maxChars !== undefined && [...value].length > maxChars) {
    throw invalid(`${name} must be at most ${maxChars} characters`)
  }
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw invalid(`${name} must be at most ${maxBytes} bytes of UTF-8`)
  }
  return value
}

const label = (value, name) => text(value, name, { maxChars: MAX_LABEL_CHARS })
const body = (value) => text(value, 'body', { maxBytes: MAX_BODY_BYTES })
const optional = (value, check, name) => (value == null ? undefined : check(value, name))

export function checkId(value, name) {
  return label(value, name)
}

export function topicInput({ title, author, body: topicBody, originSessionId } = {}) {
  return {
    title: label(title, 'title'),
    author: label(author, 'author'),
    body: optional(topicBody, body),
    originSessionId: optional(originSessionId, label, 'originSessionId'),
  }
}

export function messageInput({ topicId, author, body: messageBody, originSessionId, replyTo } = {}) {
  return {
    topicId: checkId(topicId, 'topicId'),
    author: label(author, 'author'),
    body: body(messageBody),
    originSessionId: optional(originSessionId, label, 'originSessionId'),
    replyTo: optional(replyTo, checkId, 'replyTo'),
  }
}

// Unavailable optional fields are omitted rather than stored as null.
function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

export function newTopic({ title, author, originSessionId }) {
  return compact({
    id: randomUUID(),
    title,
    created_by: author,
    created_at: new Date().toISOString(),
    origin_session_id: originSessionId,
  })
}

export function newMessage({ topicId, author, body, originSessionId, replyTo }) {
  return compact({
    id: randomUUID(),
    topic_id: topicId,
    author,
    body,
    created_at: new Date().toISOString(),
    origin_session_id: originSessionId,
    reply_to: replyTo,
  })
}

// Field name -> required. Events are flattened: { type, ...fields }.
const EVENT_FIELDS = {
  topic_created: { id: true, title: true, created_by: true, created_at: true, origin_session_id: false },
  message_posted: {
    id: true,
    topic_id: true,
    author: true,
    body: true,
    created_at: true,
    origin_session_id: false,
    reply_to: false,
  },
}

export function encodeEvent(type, data) {
  return `${JSON.stringify({ type, ...data })}\n`
}

// Parses one complete log line into { type, data }; throws with a reason if it is malformed or unknown.
export function parseEvent(line) {
  const event = JSON.parse(line)
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('record is not a JSON object')
  }
  // Non-string types would otherwise coerce to a key, e.g. ["topic_created"].
  if (typeof event.type !== 'string' || !Object.hasOwn(EVENT_FIELDS, event.type)) {
    throw new Error(`unknown record type ${JSON.stringify(event.type)}`)
  }
  const data = {}
  for (const [name, required] of Object.entries(EVENT_FIELDS[event.type])) {
    const value = event[name]
    if (value === undefined && !required) continue
    if (typeof value !== 'string' || value === '') throw new Error(`invalid ${event.type} field ${name}`)
    data[name] = value
  }
  return { type: event.type, data }
}
