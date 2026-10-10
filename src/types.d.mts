// Shared shapes of the forum core: canonical records and events, pages, and the adapter contract
// documented in the forum module. Types only: there is no runtime module, so import them with
// import type (or JSDoc @import) from this file.

// Optional fields are omitted when unavailable, never stored as null or undefined.
export interface Topic {
  id: string
  title: string
  created_by: string
  created_at: string
  origin_session_id?: string
}

export interface Message {
  id: string
  topic_id: string
  author: string
  body: string
  created_at: string
  origin_session_id?: string
  reply_to?: string
}

export interface TopicCreatedEvent {
  type: 'topic_created'
  data: Topic
}

export interface MessagePostedEvent {
  type: 'message_posted'
  data: Message
}

// Canonical { type, data } events, discriminated by type.
export type ForumEvent = TopicCreatedEvent | MessagePostedEvent
export type ForumEventType = ForumEvent['type']

// One page of a list read; next_cursor continues after its last item.
export interface Page<T> {
  items: T[]
  next_cursor: string
}

// Codes of a ForumError, which reports every expected failure of the forum and its adapters.
export type ForumErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_CURSOR'
  | 'NOT_FOUND'
  | 'FORUM_UNAVAILABLE'
  | 'LOCK_TIMEOUT'
  | 'INCOMPLETE_LOG'
  | 'WRITE_FAILED'
  | 'PARTIAL_WRITE'
  | 'ABORTED'

// Receives each warning about a damaged record skipped or a lock left behind.
export type WarningHandler = (message: string) => void

// Called for each event in append order; returning true stops the scan.
export type EventVisitor = (event: ForumEvent) => boolean | void

// Options callers pass to forum reads and writes. Absent values take the defaults.
export interface ReadCallOptions {
  onWarning?: WarningHandler | undefined
  signal?: AbortSignal | null | undefined
}

export interface ListOptions extends ReadCallOptions {
  after?: string | null | undefined
  limit?: number | null | undefined
}

export interface ListMessagesOptions extends ListOptions {
  topicId?: string | null | undefined
}

export interface WriteCallOptions {
  onWarning?: WarningHandler | undefined
}

// Inputs of the forum's writes. Absent, null and undefined optional values are all left out.
export interface CreateTopicInput {
  title: string
  author: string
  body?: string | null | undefined
  originSessionId?: string | null | undefined
}

export interface PostMessageInput {
  topicId: string
  author: string
  body: string
  originSessionId?: string | null | undefined
  replyTo?: string | null | undefined
}

// message is null for a topic created without a body.
export interface CreateTopicResult {
  topic: Topic
  message: Message | null
}

export interface CreateForumOptions {
  forumDir: string
  adapter?: ForumAdapter | undefined
  createOnRead?: boolean | undefined
}

// The forum API bound to one forum directory, as createForum returns it.
export interface Forum {
  // The requested directory.
  readonly forumDir: string
  // The adapter's identity of the pinned forum, or undefined before the first successful access.
  readonly resolved: string | undefined
  listTopics(options?: ListOptions): Promise<Page<Topic>>
  listMessages(options?: ListMessagesOptions): Promise<Page<Message>>
  getTopic(topicId: string, options?: ReadCallOptions): Promise<Topic>
  getMessage(messageId: string, options?: ReadCallOptions): Promise<Message>
  createTopic(input: CreateTopicInput, options?: WriteCallOptions): Promise<CreateTopicResult>
  postMessage(input: PostMessageInput, options?: WriteCallOptions): Promise<Message>
}

// The adapter contract. An adapter owns storage, encoding, cursors and locking.
export interface OpenOptions {
  forumDir: string
  create: boolean
  identity?: string | undefined
}

export interface StoreReadOptions {
  after?: string | undefined
  onWarning: WarningHandler
  signal?: AbortSignal | undefined
}

export interface StoreWriteOptions {
  onWarning: WarningHandler
}

// Passed to a write's function: read scans all events from the start; append adds one event.
export interface WriteTransaction {
  read(visit: EventVisitor): Promise<void>
  append(event: ForumEvent): Promise<void>
}

export interface ForumStore {
  readonly identity: string
  read(options: StoreReadOptions, visit: EventVisitor): Promise<string>
  write<T>(options: StoreWriteOptions, fn: (transaction: WriteTransaction) => Promise<T>): Promise<T>
}

export interface ForumAdapter {
  open(options: OpenOptions): Promise<ForumStore>
}
