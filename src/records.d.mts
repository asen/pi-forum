// Consumer contract of records.mjs: input checks, record construction, canonical events and
// ForumError. The shapes below are also the ones records.mjs checks its own bodies against.
import type { CreateTopicInput, ForumErrorCode, ForumEvent, Message, PostMessageInput, Topic } from './types.d.mts'

export declare const MAX_LABEL_CHARS = 256
export declare const MAX_BODY_BYTES: number

export declare class ForumError extends Error {
  code: ForumErrorCode
  // Set on a PARTIAL_WRITE: the topic that was created. Absent, not undefined, otherwise.
  topic?: Topic
  constructor(code: ForumErrorCode, message: string, options?: ErrorOptions)
}

export declare function throwIfAborted(signal: AbortSignal | null | undefined): void

// err.message for any thrown value, read exactly as JavaScript reads it: null and undefined throw a
// TypeError, and functions, boxed and primitive values give their own or inherited message, if any.
export declare function errorMessage(err: unknown): unknown

export declare function checkId(value: unknown, name: string): string

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

export declare function topicInput(input?: Unchecked<CreateTopicInput>): TopicFields
export declare function messageInput(input?: Unchecked<PostMessageInput>): MessageFields
export declare function newTopic(fields: TopicFields): Topic
export declare function newMessage(fields: MessageFields): Message

// Builds the canonical { type, data } from a flattened { type, ...fields } value; throws with a
// reason if it is malformed or of an unknown type.
export declare function canonicalEvent(event: unknown): ForumEvent
