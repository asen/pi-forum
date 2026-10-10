import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import {
  type Browser,
  type BrowserForum,
  type BrowserOptions,
  type BrowserState,
  createBrowser,
  type MessagesViewState,
} from '../extension/browser-state.ts'
import type { ForumTarget, ForumView } from '../extension/types.ts'
import { ForumError, createForum } from '../src/forum.mjs'
import type { Forum, ListOptions, Message, Topic, WarningHandler } from '../src/types.d.mts'
import { fakeAdapter } from './fake-adapter.ts'

const roots: string[] = []

after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

const TARGET: ForumTarget = { forumDir: '/forums/shared', generated: false, status: 'on', warning: null }

// A fake-adapter forum seeded with topics; each topic gets the given number of messages.
async function seeded(topics: number, messagesPerTopic = 0) {
  const forum = createForum({ forumDir: '/forums/shared', adapter: fakeAdapter() })
  const created: { topic: Topic; messages: Message[] }[] = []
  for (let i = 0; i < topics; i++) {
    const { topic } = await forum.createTopic({ title: `T${i}`, author: 'a' })
    const messages: Message[] = []
    for (let j = 0; j < messagesPerTopic; j++) {
      messages.push(await forum.postMessage({ topicId: topic.id, author: 'a', body: `${topic.title} m${j}\nmore` }))
    }
    created.push({ topic, messages })
  }
  return { forum, created }
}

// The client's methods, and one call a method received as [name, ...args].
type Method = { [K in keyof Forum]: Forum[K] extends (...args: never[]) => unknown ? K : never }[keyof Forum]
type Call = { [K in Method]: [K, ...Parameters<Forum[K]>] }[Method]

// Wraps a client so every call is recorded as [name, ...args].
function recording(forum: Forum) {
  const calls: Call[] = []
  const client = new Proxy(forum, {
    // The trap sees property names and values untyped; the functions it wraps are the client's
    // methods, so each call is recorded as a Call.
    get(target, name) {
      const value: unknown = Reflect.get(target, name)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls.push([name, ...args] as Call)
        return value(...args)
      }
    },
  })
  return { client, calls }
}

// The reads a browser makes, and what each one's promise resolves with.
type Read = 'listTopics' | 'listMessages' | 'getMessage'
type ReadResult<K extends Read> = Awaited<ReturnType<BrowserForum[K]>>

// The options the browser passes with every read: its own signal and its warning handler.
interface BrowserReadOptions extends ListOptions {
  signal: AbortSignal
  onWarning: WarningHandler
}

// One pending read: what the browser passed and how the test settles it. Each read's promise has that
// read's result type; the record takes any read's result, and tests settle each with its own.
interface DeferredCall<K extends Read = Read> {
  name: K
  args: Parameters<BrowserForum[K]>
  options: BrowserReadOptions
  resolve: (value: ReadResult<K>) => void
  reject: (reason: unknown) => void
  warn: (message: string) => void
}

// A client whose reads stay pending until the test settles them.
function deferredForum() {
  const calls: DeferredCall[] = []
  const call = <K extends Read>(name: K) => (...args: Parameters<BrowserForum[K]>) =>
    new Promise<ReadResult<K>>((resolve, reject) => {
      // The browser passes its options last on every read.
      const options = args.at(-1) as BrowserReadOptions
      // Recorded as a call of any read, whose resolve then takes any read's result.
      calls.push({ name, args, options, resolve, reject, warn: (message: string) => options.onWarning(message) } as DeferredCall)
    })
  return {
    calls,
    forum: {
      resolved: undefined,
      listTopics: call('listTopics'),
      listMessages: call('listMessages'),
      getMessage: call('getMessage'),
    } satisfies BrowserForum,
  }
}

function browserFor(forum: BrowserForum, view: ForumView, options: Partial<BrowserOptions> = {}) {
  let changes = 0
  const browser: Browser = createBrowser({ forum, target: TARGET, view, onChange: () => changes++, ...options })
  return { browser, changes: () => changes }
}

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id)

describe('navigation', () => {
  test('topics open their messages, messages open their complete record, and Back restores each parent', async () => {
    const { forum, created } = await seeded(3, 3)
    const { client, calls } = recording(forum)
    const { browser } = browserFor(client, { kind: 'topics' }, { pageSize: 2 })
    await browser.start()
    let state = browser.state
    assert.equal(state.status, 'ready')
    assert.equal(state.atRoot, true)
    assert.deepEqual(state.view, { kind: 'topics' })
    assert.deepEqual(ids(state.page!.items), [created[0]!.topic.id, created[1]!.topic.id])

    await browser.next()
    assert.deepEqual(ids(browser.state.page!.items), [created[2]!.topic.id])
    browser.select(0)
    await browser.open()
    state = browser.state
    assert.deepEqual(state.view, { kind: 'messages', topicId: created[2]!.topic.id, topic: created[2]!.topic })
    assert.equal(state.atRoot, false)
    assert.deepEqual(ids(state.page!.items), ids(created[2]!.messages.slice(0, 2)))

    await browser.next()
    browser.moveSelection(5)
    assert.equal(browser.state.page!.selection, 0)
    await browser.previous()
    browser.moveSelection(1)
    assert.equal(browser.state.page!.selection, 1)
    const chosen = created[2]!.messages[1]!
    await browser.open()
    state = browser.state
    assert.deepEqual(state.view, { kind: 'message', messageId: chosen.id })
    assert.deepEqual(state.message, chosen)
    assert.equal(state.page, null)
    assert.deepEqual(calls.at(-1)!.slice(0, 2), ['getMessage', chosen.id])

    browser.back()
    state = browser.state
    // Back returns to the topic's messages.
    assert.deepEqual((state.view as MessagesViewState).topicId, created[2]!.topic.id)
    assert.equal(state.page!.index, 0)
    assert.equal(state.page!.selection, 1)
    assert.equal(state.status, 'ready')
    const reads = calls.length
    browser.back()
    state = browser.state
    assert.deepEqual(state.view, { kind: 'topics' })
    assert.equal(state.page!.index, 1)
    assert.deepEqual(ids(state.page!.items), [created[2]!.topic.id])
    // Back shows the kept page without rereading it.
    assert.equal(calls.length, reads)

    browser.back()
    assert.equal(browser.closed, true)
    assert.equal(await browser.done, 'back')
  })

  test('all activity lists messages across topics, each with its topic identity', async () => {
    const { forum, created } = await seeded(2, 2)
    const { browser } = browserFor(forum, { kind: 'messages' })
    await browser.start()
    const { view, page } = browser.state
    assert.deepEqual(view, { kind: 'messages', topicId: undefined, topic: undefined })
    assert.deepEqual(
      // An activity view pages messages.
      (page!.items as readonly Message[]).map((m) => m.topic_id),
      [created[0]!.topic.id, created[0]!.topic.id, created[1]!.topic.id, created[1]!.topic.id],
    )
    await browser.open()
    assert.deepEqual(browser.state.message, created[0]!.messages[0]!)
  })

  test('a browser opened at a message shows its complete body and closes on Back', async () => {
    const { forum, created } = await seeded(1, 1)
    const { browser } = browserFor(forum, { kind: 'read', messageId: created[0]!.messages[0]!.id })
    await browser.start()
    assert.deepEqual(browser.state.message, created[0]!.messages[0]!)
    assert.equal(browser.state.atRoot, true)
    assert.deepEqual(
      Object.entries(browser.state.actions).filter(([, enabled]) => enabled).map(([name]) => name),
      ['back', 'refresh', 'close'],
    )
    browser.back()
    assert.equal(await browser.done, 'back')
  })

  test('Previous rereads from the kept start cursor, and Refresh forgets later pages', async () => {
    const { forum } = await seeded(5)
    // Records each read's start cursor and the next_cursor it returned; fake cursors differ per read.
    const reads: { after: string | null | undefined; next?: string }[] = []
    const client: Pick<BrowserForum, 'listTopics'> = {
      listTopics: async (options: ListOptions) => {
        const read: (typeof reads)[number] = { after: options.after }
        reads.push(read)
        const result = await forum.listTopics(options)
        read.next = result.next_cursor
        return result
      },
    }
    // @ts-expect-error -- a client with only the read this test makes
    const { browser } = browserFor(client, { kind: 'topics' }, { pageSize: 2 })
    await browser.start()
    await browser.next()
    await browser.next()
    assert.deepEqual(reads.map((read) => read.after), [undefined, reads[0]!.next, reads[1]!.next])
    const { page, actions } = browser.state
    assert.deepEqual([page!.index, page!.items.length, page!.caughtUp, actions.next], [2, 1, true, false])
    await browser.next()
    assert.equal(browser.state.page!.index, 2)
    assert.equal(reads.length, 3)

    // Previous rereads page 1 from the start cursor kept for it.
    await browser.previous()
    assert.equal(reads.at(-1)!.after, reads[0]!.next)
    assert.equal(browser.state.page!.index, 1)
    // Refresh rereads it too, and Next then follows the refreshed read rather than the earlier visit.
    await browser.refresh()
    const refreshed = reads.at(-1)!
    assert.equal(refreshed.after, reads[0]!.next)
    await browser.next()
    assert.notEqual(reads[1]!.next, refreshed.next)
    assert.equal(reads.at(-1)!.after, refreshed.next)

    await browser.previous()
    await browser.previous()
    assert.equal(reads.at(-1)!.after, undefined)
    assert.equal(browser.state.actions.previous, false)
    const count = reads.length
    await browser.previous()
    assert.equal(browser.state.page!.index, 0)
    assert.equal(reads.length, count)
  })

  test('a caught-up empty page finds new activity on Refresh', async () => {
    const { forum, created } = await seeded(1, 2)
    const topicId = created[0]!.topic.id
    const { browser } = browserFor(forum, { kind: 'messages', topicId }, { pageSize: 2 })
    await browser.start()
    assert.equal(browser.state.page!.caughtUp, false)
    await browser.next()
    assert.deepEqual(browser.state.page!.items, [])
    assert.equal(browser.state.page!.caughtUp, true)
    assert.equal(browser.state.actions.open, false)
    const later = await forum.postMessage({ topicId, author: 'b', body: 'later' })
    await browser.refresh()
    assert.deepEqual(browser.state.page!.items, [later])

    const empty = browserFor(createForum({ forumDir: '/forums/empty', adapter: fakeAdapter(), createOnRead: true }), {
      kind: 'topics',
    }).browser
    await empty.start()
    assert.deepEqual(empty.state.page!.items, [])
  })
})

describe('errors', () => {
  test('an invalid cursor offers Restart instead of resetting silently', async () => {
    const { forum } = await seeded(3)
    let invalid = false
    const client: Pick<BrowserForum, 'resolved' | 'listTopics'> = {
      get resolved() {
        return forum.resolved
      },
      listTopics: (options: ListOptions) =>
        invalid && options.after !== undefined
          ? Promise.reject(new ForumError('INVALID_CURSOR', 'cursor belongs to a different forum'))
          : forum.listTopics(options),
    }
    // @ts-expect-error -- a client with only the read this test makes
    const { browser } = browserFor(client, { kind: 'topics' }, { pageSize: 2 })
    await browser.start()
    await browser.next()
    invalid = true
    await browser.refresh()
    // Annotated so that narrowing this snapshot leaves later reads of browser.state alone.
    const { status, error, page, actions }: BrowserState = browser.state
    assert.equal(status, 'error')
    assert.deepEqual(error, {
      code: 'INVALID_CURSOR',
      message: 'cursor belongs to a different forum',
      forumDir: TARGET.forumDir,
      actions: ['restart', 'back'],
    })
    assert.deepEqual(page!.items, [])
    assert.equal(page!.index, 1)
    assert.equal(actions.retry, false)
    assert.equal(actions.restart, true)
    await browser.restart()
    assert.equal(browser.state.status, 'ready')
    assert.equal(browser.state.page!.index, 0)
    assert.equal(browser.state.page!.items.length, 2)
  })

  test('a missing message offers Retry and Back, and Back keeps the parent view', async () => {
    const { forum, created } = await seeded(1, 1)
    const missing = browserFor(forum, { kind: 'read', messageId: 'nope' }).browser
    await missing.start()
    assert.deepEqual(missing.state.error, {
      code: 'NOT_FOUND',
      message: 'message nope not found',
      forumDir: TARGET.forumDir,
      actions: ['retry', 'back'],
    })
    assert.equal(missing.state.actions.retry, true)
    missing.back()
    assert.equal(await missing.done, 'back')

    let fail = true
    const client: Pick<BrowserForum, 'listMessages' | 'getMessage'> = {
      listMessages: (options) => forum.listMessages(options),
      getMessage: (id, options) => (fail ? Promise.reject(new ForumError('NOT_FOUND', `message ${id} not found`)) : forum.getMessage(id, options)),
    }
    // @ts-expect-error -- a client with only the reads this test makes
    const { browser } = browserFor(client, { kind: 'messages', topicId: created[0]!.topic.id })
    await browser.start()
    await browser.open()
    assert.equal(browser.state.error!.code, 'NOT_FOUND')
    fail = false
    await browser.retry()
    assert.deepEqual(browser.state.message, created[0]!.messages[0]!)
    browser.back()
    assert.equal(browser.state.status, 'ready')
    // A fresh snapshot of the parent view, not the message view's narrowed above.
    assert.deepEqual((browser.state as BrowserState).page!.items, created[0]!.messages)
  })

  test('an unavailable forum names its directory, and Retry recovers once it exists', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-browser-test-'))
    roots.push(root)
    const forumDir = path.join(root, 'forum')
    const forum = createForum({ forumDir })
    const target = { ...TARGET, forumDir }
    const browser = createBrowser({ forum, target, view: { kind: 'topics' } })
    await browser.start()
    assert.equal(browser.state.error!.code, 'FORUM_UNAVAILABLE')
    assert.equal(browser.state.error!.forumDir, forumDir)
    // A ForumError's message, which is a string.
    assert.match(browser.state.error!.message as string, /ENOENT/)
    assert.deepEqual(browser.state.error!.actions, ['retry', 'back'])
    assert.equal(browser.state.target.resolved, undefined)
    await assert.rejects(fs.stat(forumDir), { code: 'ENOENT' })

    const { topic } = await createForum({ forumDir }).createTopic({ title: 'Now', author: 'a' })
    await browser.retry()
    assert.deepEqual(browser.state.page!.items, [topic])
    // The client's resolved directory is live once it has read.
    assert.equal(browser.state.target.resolved, await fs.realpath(forumDir))
  })
})

// Reads here stay pending until the test settles them; a regression fails by timeout rather than hanging.
describe('requests', { timeout: 10000 }, () => {
  test('superseded loads, their late completions and late warnings are ignored', async () => {
    const { forum, calls } = deferredForum()
    const { browser, changes } = browserFor(forum, { kind: 'topics' })
    browser.start()
    browser.refresh()
    await Promise.resolve()
    await Promise.resolve()
    const [first, second] = calls
    assert.equal(first!.options.signal.aborted, true)
    assert.equal(second!.options.signal.aborted, false)
    second!.warn('kept warning')
    const seen = changes()
    first!.warn('late warning')
    // @ts-expect-error -- stand-in topics with only the id the browser reads
    first!.resolve({ items: [{ id: 'stale' }], next_cursor: 'c' })
    first!.reject(new ForumError('ABORTED', 'aborted'))
    await new Promise(setImmediate)
    assert.equal(changes(), seen)
    assert.equal(browser.state.status, 'loading')
    assert.deepEqual(browser.state.warnings, { items: ['kept warning'], omitted: 0 })

    // @ts-expect-error -- stand-in topics with only the id the browser reads
    second!.resolve({ items: [{ id: 'fresh' }], next_cursor: 'c' })
    await new Promise(setImmediate)
    assert.deepEqual(ids(browser.state.page!.items), ['fresh'])
    second!.warn('after completion')
    assert.deepEqual(browser.state.warnings.items, ['kept warning', 'after completion'])
  })

  test('Back during a child load abandons it and keeps the parent untouched', async () => {
    const { forum, calls } = deferredForum()
    const { browser } = browserFor(forum, { kind: 'topics' })
    browser.start()
    await new Promise(setImmediate)
    // @ts-expect-error -- stand-in topics with only the id and title the browser reads
    calls[0]!.resolve({ items: [{ id: 't1', title: 'T1' }], next_cursor: 'c' })
    await new Promise(setImmediate)
    browser.open()
    await new Promise(setImmediate)
    const child = calls[1]!
    assert.equal(child.name, 'listMessages')
    browser.back()
    assert.equal(child.options.signal.aborted, true)
    // @ts-expect-error -- stand-in messages with only an id
    child.resolve({ items: [{ id: 'late' }], next_cursor: 'c' })
    await new Promise(setImmediate)
    assert.deepEqual(browser.state.view, { kind: 'topics' })
    assert.deepEqual(ids(browser.state.page!.items), ['t1'])
  })

  test('closing aborts the current load, settles done once and stays silent', async () => {
    const { forum, calls } = deferredForum()
    const { browser, changes } = browserFor(forum, { kind: 'messages', topicId: 't' })
    const started = browser.start()
    await new Promise(setImmediate)
    const seen = changes()
    browser.close()
    browser.close('again')
    assert.equal(calls[0]!.options.signal.aborted, true)
    assert.equal(await browser.done, 'closed')
    assert.equal(browser.closeReason, 'closed')
    calls[0]!.warn('late')
    // @ts-expect-error -- stand-in messages with only an id
    calls[0]!.resolve({ items: [{ id: 'late' }], next_cursor: 'c' })
    await started
    await Promise.all([browser.refresh(), browser.next(), browser.previous(), browser.restart(), browser.open()])
    browser.back()
    browser.select(1)
    assert.equal(changes(), seen)
    assert.equal(calls.length, 1)
    assert.equal(browser.state.closed, true)
    assert.deepEqual(browser.state.warnings, { items: [], omitted: 0 })
  })

  test('warnings are capped per load with an omitted count', async () => {
    const { forum, calls } = deferredForum()
    const { browser } = browserFor(forum, { kind: 'topics' }, { warningLimit: 3 })
    browser.start()
    await new Promise(setImmediate)
    for (let i = 0; i < 5; i++) calls[0]!.warn(`w${i}`)
    calls[0]!.resolve({ items: [], next_cursor: 'c' })
    await new Promise(setImmediate)
    assert.deepEqual(browser.state.warnings, { items: ['w0', 'w1', 'w2'], omitted: 2 })
    browser.refresh()
    assert.deepEqual(browser.state.warnings, { items: [], omitted: 0 })
  })

  test('the lifetime signal closes the browser, before or after it starts', async () => {
    const { forum, calls } = deferredForum()
    const lifetime = new AbortController()
    const { browser } = browserFor(forum, { kind: 'topics' }, { signal: lifetime.signal })
    browser.start()
    await new Promise(setImmediate)
    lifetime.abort()
    assert.equal(await browser.done, 'discarded')
    assert.equal(calls[0]!.options.signal.aborted, true)

    const ended = browserFor(forum, { kind: 'topics' }, { signal: lifetime.signal }).browser
    assert.equal(ended.closed, true)
    await ended.start()
    assert.equal(calls.length, 1)

    // A browser's own signal is separate from the lifetime signal it is given.
    const live = new AbortController()
    const own = browserFor(forum, { kind: 'topics' }, { signal: live.signal }).browser
    own.start()
    await new Promise(setImmediate)
    own.close()
    assert.equal(live.signal.aborted, false)
    assert.equal(calls[1]!.options.signal.aborted, true)
  })
})
