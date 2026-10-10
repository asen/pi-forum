import { randomUUID } from 'node:crypto'

/**
 * @import { CreateTopicInput, ForumErrorCode, ForumEvent, Message, PostMessageInput, Topic } from './types.d.mts'
 * @import { MessageFields, TopicFields, Unchecked } from './records.d.mts'
 */

export const MAX_LABEL_CHARS = 256
export const MAX_BODY_BYTES = 64 * 1024

// A PARTIAL_WRITE also carries topic, the topic that was created (see records.d.mts). It is assigned
// only then, so other errors have no topic property at all.
export class ForumError extends Error {
  /**
   * @param {ForumErrorCode} code
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ForumError'
    /** @type {ForumErrorCode} */
    this.code = code
  }
}

/** @param {AbortSignal | null | undefined} signal */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw new ForumError('ABORTED', 'the operation was aborted', { cause: signal.reason })
}

// err.message for any thrown value, read exactly as JavaScript reads it: null and undefined throw a
// TypeError, and functions, boxed and primitive values give their own or inherited message, if any.
/**
 * @param {unknown} err
 * @returns {unknown}
 */
export function errorMessage(err) {
  // Asserted only to allow the property access; no value other than null or undefined fails it.
  return /** @type {{ readonly message?: unknown }} */ (err).message
}

/**
 * @param {string} message
 * @returns {ForumError}
 */
function invalid(message) {
  return new ForumError('INVALID_INPUT', message)
}

/**
 * @typedef {object} TextLimits
 * @property {number} [maxChars]
 * @property {number} [maxBytes]
 */

/**
 * @param {unknown} value
 * @param {string} name
 * @param {TextLimits} limits
 * @returns {string}
 */
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

/** @typedef {(value: unknown, name: string) => string} Check */

/** @type {Check} */
const label = (value, name) => text(value, name, { maxChars: MAX_LABEL_CHARS })
/** @param {unknown} value */
const body = (value) => text(value, 'body', { maxBytes: MAX_BODY_BYTES })
/**
 * @param {unknown} value
 * @param {Check} check
 * @param {string} name
 * @returns {string | undefined}
 */
const optional = (value, check, name) => (value == null ? undefined : check(value, name))

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
export function checkId(value, name) {
  return label(value, name)
}

/**
 * @param {Unchecked<CreateTopicInput>} [input]
 * @returns {TopicFields}
 */
export function topicInput({ title, author, body: topicBody, originSessionId } = {}) {
  return {
    title: label(title, 'title'),
    author: label(author, 'author'),
    body: optional(topicBody, body, 'body'),
    originSessionId: optional(originSessionId, label, 'originSessionId'),
  }
}

/**
 * @param {Unchecked<PostMessageInput>} [input]
 * @returns {MessageFields}
 */
export function messageInput({ topicId, author, body: messageBody, originSessionId, replyTo } = {}) {
  return {
    topicId: checkId(topicId, 'topicId'),
    author: label(author, 'author'),
    body: body(messageBody),
    originSessionId: optional(originSessionId, label, 'originSessionId'),
    replyTo: optional(replyTo, checkId, 'replyTo'),
  }
}

// A record before compact: its optional fields may still be undefined.
/**
 * @template T
 * @typedef {{ [K in keyof T]: {} extends Pick<T, K> ? T[K] | undefined : T[K] }} Draft
 */

// Unavailable optional fields are omitted rather than stored as null.
/**
 * @template T
 * @param {Draft<T>} record
 * @returns {T}
 */
function compact(record) {
  /** @type {[string, unknown][]} */
  const entries = Object.entries(record)
  // Only undefined optional fields are dropped, which leaves a T.
  return /** @type {T} */ (Object.fromEntries(entries.filter(([, value]) => value !== undefined)))
}

/**
 * @param {TopicFields} fields
 * @returns {Topic}
 */
export function newTopic({ title, author, originSessionId }) {
  /** @type {Draft<Topic>} */
  const draft = {
    id: randomUUID(),
    title,
    created_by: author,
    created_at: new Date().toISOString(),
    origin_session_id: originSessionId,
  }
  return compact(draft)
}

/**
 * @param {MessageFields} fields
 * @returns {Message}
 */
export function newMessage({ topicId, author, body, originSessionId, replyTo }) {
  /** @type {Draft<Message>} */
  const draft = {
    id: randomUUID(),
    topic_id: topicId,
    author,
    body,
    created_at: new Date().toISOString(),
    origin_session_id: originSessionId,
    reply_to: replyTo,
  }
  return compact(draft)
}

// Field name -> required, for every field of the record.
/**
 * @template T
 * @typedef {{ readonly [K in keyof T]-?: {} extends Pick<T, K> ? false : true }} FieldSpec
 */

// Events are { type, data } with data holding the canonical record.
/** @type {{ readonly [E in ForumEvent as E['type']]: FieldSpec<E['data']> }} */
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

/**
 * @param {unknown} value
 * @returns {value is Readonly<Record<string, unknown>>}
 */
const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * @param {unknown} type
 * @returns {type is ForumEvent['type']}
 */
const isEventType = (type) => typeof type === 'string' && Object.hasOwn(EVENT_FIELDS, type)

// Builds the canonical { type, data } from a flattened { type, ...fields } value; throws with a
// reason if it is malformed or of an unknown type.
/**
 * @param {unknown} event
 * @returns {ForumEvent}
 */
export function canonicalEvent(event) {
  if (!isJsonObject(event)) {
    throw new Error('record is not a JSON object')
  }
  // Non-string types would otherwise coerce to a key, e.g. ["topic_created"].
  if (!isEventType(event.type)) {
    throw new Error(`unknown record type ${JSON.stringify(event.type)}`)
  }
  // Fields of the type's record by name; typed so that it can be asserted to be that record.
  /** @type {Record<string, string> & Partial<Topic & Message>} */
  const data = {}
  for (const [name, required] of Object.entries(EVENT_FIELDS[event.type])) {
    const value = event[name]
    if (value === undefined && !required) continue
    if (typeof value !== 'string' || value === '') throw new Error(`invalid ${event.type} field ${name}`)
    data[name] = value
  }
  // data holds a non-empty string for each required field of the type's record and only its fields.
  return /** @type {ForumEvent} */ ({ type: event.type, data })
}
