import path from 'node:path'
import { jsonlAdapter } from './backends/jsonl.mjs'
import {
  ForumError,
  checkId,
  errorMessage,
  messageInput,
  newMessage,
  newTopic,
  throwIfAborted,
  topicInput,
} from './records.mjs'
import { compileSearchQuery } from './search-query.mjs'

/**
 * @import {
 *   CreateForumOptions,
 *   CreateTopicInput,
 *   CreateTopicResult,
 *   Forum,
 *   ForumEvent,
 *   ForumStore,
 *   ListMessagesOptions,
 *   ListOptions,
 *   Message,
 *   MessagePostedEvent,
 *   Page,
 *   PostMessageInput,
 *   ReadCallOptions,
 *   SearchHit,
 *   Topic,
 *   TopicCreatedEvent,
 *   WarningHandler,
 *   WriteCallOptions,
 *   WriteTransaction,
 * } from './types.d.mts'
 */

export { ForumError }

// Shared forum API bound to one forum directory. Validation, limits, record construction and
// errors live here; an adapter owns storage, encoding, cursors and locking:
//
//   adapter.open({ forumDir, create, identity }) -> store
//     Without create it must not create storage, and reports a forum it cannot reach as
//     FORUM_UNAVAILABLE. store.identity is a string naming the forum forumDir resolved to; given
//     the identity of an earlier open, a forumDir that now resolves elsewhere is FORUM_UNAVAILABLE.
//   store.read({ after, onWarning, signal }, visit) -> cursor
//     Calls visit({ type, data }) for each canonical event after the cursor, in append order,
//     until visit returns true. Resolves to an opaque cursor after the last event consumed.
//     Cursors come only from this adapter; an unusable one is INVALID_CURSOR. Once the optional
//     AbortSignal is aborted it should stop, releasing what it holds, and fail with ABORTED.
//   store.write({ onWarning }, fn) -> fn's result
//     Runs fn({ read(visit), append(event) }) exclusively among writers. read scans all events
//     from the start, as above; append adds one event or fails with WRITE_FAILED.
//
// The adapter contract and the API's inputs and results are typed in types.d.mts.

const DEFAULT_TOPIC_LIMIT = 20
const DEFAULT_MESSAGE_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 20
const MAX_LIMIT = 100

/** @type {WarningHandler} */
const defaultWarning = (message) => console.warn(`pi-forum: warning: ${message}`)

/**
 * @param {unknown} forumDir
 * @returns {asserts forumDir is string}
 */
function checkForumDir(forumDir) {
  if (typeof forumDir !== 'string' || !path.isAbsolute(forumDir)) {
    throw new ForumError('INVALID_INPUT', 'forum directory must be an absolute path')
  }
}

/**
 * @param {number | null | undefined} limit
 * @param {number} defaultLimit
 * @returns {number}
 */
function checkLimit(limit, defaultLimit) {
  if (limit == null) return defaultLimit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ForumError('INVALID_INPUT', `limit must be an integer from 1 to ${MAX_LIMIT}`)
  }
  return limit
}

/**
 * @param {AbortSignal | null | undefined} signal
 * @returns {AbortSignal | undefined}
 */
function checkSignal(signal) {
  if (signal != null && !(signal instanceof AbortSignal)) {
    throw new ForumError('INVALID_INPUT', 'signal must be an AbortSignal')
  }
  throwIfAborted(signal)
  return signal ?? undefined
}

/**
 * @param {string | null | undefined} after
 * @returns {string | undefined}
 */
function checkCursor(after) {
  if (after != null && (typeof after !== 'string' || after === '')) {
    throw new ForumError('INVALID_CURSOR', 'cursor is not valid')
  }
  return after ?? undefined
}

/** @param {string} id */
const isTopic =
  (id) =>
  /**
   * @param {ForumEvent} event
   * @returns {event is TopicCreatedEvent}
   */
  (event) =>
    event.type === 'topic_created' && event.data.id === id
/** @param {string} id */
const isMessage =
  (id) =>
  /**
   * @param {ForumEvent} event
   * @returns {event is MessagePostedEvent}
   */
  (event) =>
    event.type === 'message_posted' && event.data.id === id

// Reads use createOnRead to decide whether an absent forum is created or reported; writes create it.
// Storage is first touched by the first call. The forum it resolves to on the first successful access
// is pinned for this client only; a new client is needed to follow forumDir somewhere else.
/**
 * @overload
 * @param {CreateForumOptions} options
 * @returns {Forum}
 */
/**
 * @param {Partial<CreateForumOptions>} [options]
 * @returns {Forum}
 */
export function createForum({ forumDir, adapter = jsonlAdapter, createOnRead = false } = {}) {
  checkForumDir(forumDir)
  /** @type {string | undefined} */
  let resolved
  /** @param {boolean} create */
  const open = (create) => adapter.open({ forumDir, create, identity: resolved })

  // Concurrent first calls may resolve differently; only the first to succeed is kept.
  /**
   * @param {ForumStore} store
   * @returns {void}
   */
  function pin(store) {
    resolved ??= store.identity
    if (store.identity !== resolved) {
      throw new ForumError('FORUM_UNAVAILABLE', `forum directory ${forumDir} no longer resolves to ${resolved}`)
    }
  }

  // Reads are cancelled through an optional AbortSignal: once it is aborted they fail with ABORTED
  // and never return a partial page or record. select returns the item an event lists, if any.
  /**
   * @template T
   * @param {ListOptions} options
   * @param {number} defaultLimit
   * @param {(event: ForumEvent) => T | false} select
   * @returns {Promise<Page<T>>}
   */
  async function list({ after, limit, onWarning = defaultWarning, signal }, defaultLimit, select) {
    const pageLimit = checkLimit(limit, defaultLimit)
    const start = checkCursor(after)
    const checkedSignal = checkSignal(signal)
    const store = await open(createOnRead)
    throwIfAborted(checkedSignal)
    /** @type {T[]} */
    const items = []
    const next_cursor = await store.read({ after: start, onWarning, signal: checkedSignal }, (event) => {
      const item = select(event)
      if (item) items.push(item)
      return items.length === pageLimit
    })
    throwIfAborted(checkedSignal)
    pin(store)
    return { items, next_cursor }
  }

  /**
   * @template {ForumEvent} E
   * @param {(event: ForumEvent) => event is E} match
   * @param {ReadCallOptions} options
   * @param {string} notFound
   * @returns {Promise<E['data']>}
   */
  async function find(match, { onWarning = defaultWarning, signal }, notFound) {
    const checkedSignal = checkSignal(signal)
    const store = await open(createOnRead)
    throwIfAborted(checkedSignal)
    /** @type {E['data'] | undefined} */
    let found
    await store.read({ onWarning, signal: checkedSignal }, (event) => {
      if (match(event)) found = event.data
      return found !== undefined
    })
    throwIfAborted(checkedSignal)
    pin(store)
    if (found === undefined) throw new ForumError('NOT_FOUND', notFound)
    return found
  }

  return {
    // The requested directory, and the adapter's identity of the pinned forum (for JSONL its real
    // directory), or undefined before the first successful access.
    /** @returns {string} */
    get forumDir() {
      return forumDir
    },
    /** @returns {string | undefined} */
    get resolved() {
      return resolved
    },

    /**
     * @param {ListOptions} [options]
     * @returns {Promise<Page<Topic>>}
     */
    async listTopics(options = {}) {
      return list(options, DEFAULT_TOPIC_LIMIT, ({ type, data }) => type === 'topic_created' && data)
    },

    // Without topicId, lists messages across the forum; an unknown topic lists nothing.
    /**
     * @param {ListMessagesOptions} [options]
     * @returns {Promise<Page<Message>>}
     */
    async listMessages({ topicId, ...options } = {}) {
      if (topicId != null) checkId(topicId, 'topicId')
      return list(
        options,
        DEFAULT_MESSAGE_LIMIT,
        ({ type, data }) => type === 'message_posted' && (topicId == null || data.topic_id === topicId) && data,
      )
    },

    // Matches the query against each topic's title and each message's body on its own, and lists
    // every matching record once, in append order. The query is checked before storage is touched.
    // Like a list's, the cursor is a position in the forum, after every record the page read
    // whether it matched or not; it is not bound to the query.
    /**
     * @param {string} query
     * @param {ListOptions} [options]
     * @returns {Promise<Page<SearchHit>>}
     */
    async search(query, options = {}) {
      const matches = compileSearchQuery(query)
      return list(
        options,
        DEFAULT_SEARCH_LIMIT,
        /**
         * @param {ForumEvent} event
         * @returns {SearchHit | false}
         */
        (event) =>
          event.type === 'topic_created'
            ? matches(event.data.title) && { type: 'topic', topic: event.data }
            : matches(event.data.body) && { type: 'message', message: event.data },
      )
    },

    /**
     * @param {string} topicId
     * @param {ReadCallOptions} [options]
     * @returns {Promise<Topic>}
     */
    async getTopic(topicId, options = {}) {
      checkId(topicId, 'topicId')
      return find(isTopic(topicId), options, `topic ${topicId} not found`)
    },

    /**
     * @param {string} messageId
     * @param {ReadCallOptions} [options]
     * @returns {Promise<Message>}
     */
    async getMessage(messageId, options = {}) {
      checkId(messageId, 'messageId')
      return find(isMessage(messageId), options, `message ${messageId} not found`)
    },

    // Topic and initial message are two appends. If the second fails, the error carries the created topic.
    /**
     * @param {CreateTopicInput} input
     * @param {WriteCallOptions} [options]
     * @returns {Promise<CreateTopicResult>}
     */
    async createTopic(input, { onWarning = defaultWarning } = {}) {
      const fields = topicInput(input)
      const store = await open(true)
      return store.write(
        { onWarning },
        /**
         * @param {WriteTransaction} transaction
         * @returns {Promise<CreateTopicResult>}
         */
        async ({ append }) => {
          pin(store)
          const topic = newTopic(fields)
          await append({ type: 'topic_created', data: topic })
          if (fields.body === undefined) return { topic, message: null }
          const message = newMessage({ ...fields, body: fields.body, topicId: topic.id })
          try {
            await append({ type: 'message_posted', data: message })
          } catch (err) {
            const partial = new ForumError(
              'PARTIAL_WRITE',
              `topic ${topic.id} was created but its initial message was not appended: ${errorMessage(err)}`,
              { cause: err },
            )
            partial.topic = topic
            throw partial
          }
          return { topic, message }
        },
      )
    },

    /**
     * @param {PostMessageInput} input
     * @param {WriteCallOptions} [options]
     * @returns {Promise<Message>}
     */
    async postMessage(input, { onWarning = defaultWarning } = {}) {
      const fields = messageInput(input)
      const store = await open(true)
      return store.write({ onWarning }, async ({ read, append }) => {
        pin(store)
        let topicFound = false
        // Widened for the visitor's assignment, which narrowing cannot see.
        let reply = /** @type {Message | null} */ (null)
        await read(({ type, data }) => {
          if (type === 'topic_created' && data.id === fields.topicId) topicFound = true
          if (type === 'message_posted' && data.id === fields.replyTo) reply = data
        })
        if (!topicFound) throw new ForumError('NOT_FOUND', `topic ${fields.topicId} not found`)
        if (fields.replyTo !== undefined) {
          if (!reply) throw new ForumError('NOT_FOUND', `message ${fields.replyTo} not found`)
          if (reply.topic_id !== fields.topicId) {
            throw new ForumError('INVALID_INPUT', `message ${fields.replyTo} belongs to a different topic`)
          }
        }
        const message = newMessage(fields)
        await append({ type: 'message_posted', data: message })
        return message
      })
    },
  }
}
