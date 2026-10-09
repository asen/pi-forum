import { randomUUID } from 'node:crypto'
import type { CreateTopicInput, ForumErrorCode, ForumEvent, Message, PostMessageInput, Topic } from './types.js'

export const MAX_LABEL_CHARS = 256
export const MAX_BODY_BYTES = 64 * 1024

export class ForumError extends Error {
  declare code: ForumErrorCode
  // Set on a PARTIAL_WRITE: the topic that was created.
  declare topic?: Topic

  constructor(code: ForumErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ForumError'
    this.code = code
  }
}

export function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new ForumError('ABORTED', 'the operation was aborted', { cause: signal.reason })
}

// err.message for any thrown value, read exactly as JavaScript reads it: null and undefined throw a
// TypeError, and functions, boxed and primitive values give their own or inherited message, if any.
export function errorMessage(err: unknown): unknown {
  // Asserted only to allow the property access; no value other than null or undefined fails it.
  return (err as { readonly message?: unknown }).message
}

function invalid(message: string): ForumError {
  return new ForumError('INVALID_INPUT', message)
}

interface TextLimits {
  maxChars?: number
  maxBytes?: number
}

function text(value: unknown, name: string, { maxChars, maxBytes }: TextLimits): string {
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

const label = (value: unknown, name: string) => text(value, name, { maxChars: MAX_LABEL_CHARS })
const body = (value: unknown) => text(value, 'body', { maxBytes: MAX_BODY_BYTES })
const optional = (value: unknown, check: (value: unknown, name: string) => string, name: string) =>
  value == null ? undefined : check(value, name)

export function checkId(value: unknown, name: string): string {
  return label(value, name)
}

// Inputs as callers may pass them: every field is checked, so none is trusted to have its type.
export type Unchecked<T> = { [K in keyof T]?: unknown }

// Checked inputs; optional values are undefined when absent.
export interface TopicFields {
  title: string
  author: string
  body?: string | undefined
  originSessionId?: string | undefined
}

export interface MessageFields {
  topicId: string
  author: string
  body: string
  originSessionId?: string | undefined
  replyTo?: string | undefined
}

export function topicInput({
  title,
  author,
  body: topicBody,
  originSessionId,
}: Unchecked<CreateTopicInput> = {}): TopicFields {
  return {
    title: label(title, 'title'),
    author: label(author, 'author'),
    body: optional(topicBody, body, 'body'),
    originSessionId: optional(originSessionId, label, 'originSessionId'),
  }
}

export function messageInput({
  topicId,
  author,
  body: messageBody,
  originSessionId,
  replyTo,
}: Unchecked<PostMessageInput> = {}): MessageFields {
  return {
    topicId: checkId(topicId, 'topicId'),
    author: label(author, 'author'),
    body: body(messageBody),
    originSessionId: optional(originSessionId, label, 'originSessionId'),
    replyTo: optional(replyTo, checkId, 'replyTo'),
  }
}

// A record before compact: its optional fields may still be undefined.
type Draft<T> = { [K in keyof T]: {} extends Pick<T, K> ? T[K] | undefined : T[K] }

// Unavailable optional fields are omitted rather than stored as null.
function compact<T>(record: Draft<T>): T {
  const entries: [string, unknown][] = Object.entries(record)
  // Only undefined optional fields are dropped, which leaves a T.
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined)) as T
}

export function newTopic({ title, author, originSessionId }: TopicFields): Topic {
  return compact<Topic>({
    id: randomUUID(),
    title,
    created_by: author,
    created_at: new Date().toISOString(),
    origin_session_id: originSessionId,
  })
}

export function newMessage({ topicId, author, body, originSessionId, replyTo }: MessageFields): Message {
  return compact<Message>({
    id: randomUUID(),
    topic_id: topicId,
    author,
    body,
    created_at: new Date().toISOString(),
    origin_session_id: originSessionId,
    reply_to: replyTo,
  })
}

// Field name -> required, for every field of the record.
type FieldSpec<T> = { readonly [K in keyof T]-?: {} extends Pick<T, K> ? false : true }

// Events are { type, data } with data holding the canonical record.
const EVENT_FIELDS: { readonly [E in ForumEvent as E['type']]: FieldSpec<E['data']> } = {
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

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isEventType = (type: unknown): type is ForumEvent['type'] =>
  typeof type === 'string' && Object.hasOwn(EVENT_FIELDS, type)

// Builds the canonical { type, data } from a flattened { type, ...fields } value; throws with a
// reason if it is malformed or of an unknown type.
export function canonicalEvent(event: unknown): ForumEvent {
  if (!isJsonObject(event)) {
    throw new Error('record is not a JSON object')
  }
  // Non-string types would otherwise coerce to a key, e.g. ["topic_created"].
  if (!isEventType(event.type)) {
    throw new Error(`unknown record type ${JSON.stringify(event.type)}`)
  }
  // Fields of the type's record by name; typed so that it can be asserted to be that record.
  const data: Record<string, string> & Partial<Topic & Message> = {}
  for (const [name, required] of Object.entries(EVENT_FIELDS[event.type])) {
    const value = event[name]
    if (value === undefined && !required) continue
    if (typeof value !== 'string' || value === '') throw new Error(`invalid ${event.type} field ${name}`)
    data[name] = value
  }
  // data holds a non-empty string for each required field of the type's record and only its fields.
  return { type: event.type, data } as ForumEvent
}
