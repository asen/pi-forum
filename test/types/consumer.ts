// Type-regression fixture: how a consumer of the installed package uses its public types, compiled
// by test/types.test.ts against the packed package (node_modules/pi-forum), never the checkout, and
// without allowJs: the core's types come from its maintained .d.mts sidecars and the extension's from
// its TypeScript, never from inferring the JavaScript. It imports pi-forum by package name, so it is
// the one file under test/ that npm run typecheck leaves out (see tsconfig.tooling.json); the test
// compiles it instead. The plain statements must compile. Each @ts-expect-error marks a use the
// types must reject; if a type widened (to any, say), the unused directive fails the compile.
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { createBrowser, type BrowserForum } from 'pi-forum/extension/browser-state.ts'
import { createBrowserOpener, type BrowserTui } from 'pi-forum/extension/browser.ts'
import { createEntryRenderer, ENTRY_TYPE, entryData } from 'pi-forum/extension/entry-renderer.ts'
import piForum from 'pi-forum/extension/forum.ts'
import { formatTopicList, textCommand } from 'pi-forum/extension/output.ts'
import { createPreferenceStore } from 'pi-forum/extension/preferences.ts'
import { createForumRuntime } from 'pi-forum/extension/runtime.ts'
import type { ForumTarget, ForumView, PromptEvent, RuntimeContext } from 'pi-forum/extension/types.ts'
import { jsonlAdapter } from 'pi-forum/src/backends/jsonl.mjs'
import { main, type Environment, type ForumFactory, type MainOptions, type OutputWriter } from 'pi-forum/src/cli.mjs'
import { decodeCursor, encodeCursor, type CursorData } from 'pi-forum/src/cursor.mjs'
import { createForum, ForumError } from 'pi-forum/src/forum.mjs'
import { canonicalEvent, checkId, MAX_BODY_BYTES, MAX_LABEL_CHARS, newTopic, topicInput, type TopicFields, type Unchecked } from 'pi-forum/src/records.mjs'
import * as storage from 'pi-forum/src/storage.mjs'
import type { CreateTopicInput, Forum, ForumAdapter, ForumErrorCode, ForumEvent, ForumStore, Message, Page, Topic } from 'pi-forum/src/types.d.mts'

// Pi: the extension is a factory Pi can load, and Pi's own objects fit what pi-forum asks for.
export const factory: ExtensionFactory = piForum
export function register(pi: ExtensionAPI, ctx: ExtensionCommandContext, event: BeforeAgentStartEvent): void {
  piForum(pi)
  const runtimeContext: RuntimeContext = ctx
  const promptEvent: PromptEvent = event
  pi.registerEntryRenderer(ENTRY_TYPE, createEntryRenderer({ Text }))
  pi.appendEntry(ENTRY_TYPE, entryData('text'))
  const tui: BrowserTui = { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi }
  const runtime = createForumRuntime({
    binDir: '/pkg/bin',
    getAgentDir: () => '/agent',
    createForum,
    openBrowser: createBrowserOpener(tui),
    visibleWidth,
    preferences: createPreferenceStore({ getAgentDir: () => '/agent' }),
  })
  runtime.sessionStart(runtimeContext)
  runtime.beforeAgentStart(promptEvent, runtimeContext)
  // @ts-expect-error: the factory needs Pi's extension API
  piForum({})
  // @ts-expect-error: a runtime context has a UI, a mode and a session
  runtime.sessionStart({ cwd: '/project' })
  // @ts-expect-error: the entry renderer needs pi-tui's Text component
  createEntryRenderer({ Text: String })
  // @ts-expect-error: the runtime needs the bin directory to expose
  createForumRuntime({ getAgentDir: () => '/agent' })
}

// The forum API, with the JSONL adapter or a custom one.
export async function useForum(signal: AbortSignal): Promise<Message> {
  const forum: Forum = createForum({ forumDir: '/abs/forum', adapter: jsonlAdapter, createOnRead: false })
  const topics: Page<Topic> = await forum.listTopics({ limit: 20, signal, onWarning: (message: string) => void message })
  const first: Topic | undefined = topics.items[0]
  const page: Page<Message> = await forum.listMessages({ topicId: first?.id, after: topics.next_cursor })
  const { topic, message } = await forum.createTopic({ title: 'Plan', author: 'agent', body: 'Notes' })
  const resolved: string | undefined = forum.resolved
  void [page, resolved]
  // @ts-expect-error: an author is required
  await forum.createTopic({ title: 'Plan' })
  // @ts-expect-error: a message has a body
  await forum.postMessage({ topicId: topic.id, author: 'agent' })
  // @ts-expect-error: the directory is a path string
  createForum({ forumDir: 42 })
  // @ts-expect-error: the pinned identity is read-only
  forum.resolved = '/elsewhere'
  // @ts-expect-error: items may be missing at any index
  const unchecked: Topic = topics.items[0]
  void unchecked
  return forum.postMessage({ topicId: topic.id, author: 'agent', body: 'Reply', replyTo: message?.id })
}

export function errorCode(err: unknown): ForumErrorCode | null {
  if (!(err instanceof ForumError)) return null
  const created: Topic | undefined = err.topic
  void created
  // @ts-expect-error: not a ForumError code
  const unknown: ForumErrorCode = 'NOPE'
  void unknown
  // @ts-expect-error: the created topic is absent, never undefined
  err.topic = undefined
  return err.code
}
export const notFound: ForumError = new ForumError('NOT_FOUND', 'no such topic', { cause: null })
// @ts-expect-error: a ForumError has one of its codes
new ForumError('NOPE', 'message')
// The compatibility wrappers throw the same class.
export const sameError: typeof ForumError = storage.ForumError

// Events: what an adapter stores and replays, narrowed by type.
export function describeEvent(event: ForumEvent): string {
  switch (event.type) {
    case 'topic_created':
      return event.data.title
    case 'message_posted':
      return event.data.body
  }
}
const topicValue: Topic = { id: 't', title: 'Plan', created_by: 'agent', created_at: '2026-01-01T00:00:00.000Z' }
export const events: ForumEvent[] = [{ type: 'topic_created', data: topicValue }]
// @ts-expect-error: not an event type
events.push({ type: 'topic_deleted', data: topicValue })
// @ts-expect-error: a posted message carries a message
events.push({ type: 'message_posted', data: topicValue })

export const memoryAdapter: ForumAdapter = {
  async open({ forumDir, create }) {
    const log: ForumEvent[] = []
    const store: ForumStore = {
      identity: forumDir,
      async read({ after, signal }, visit) {
        signal?.throwIfAborted()
        for (const event of log.slice(Number(after ?? 0))) if (visit(event) === true) break
        return String(log.length)
      },
      async write(_options, fn) {
        return fn({
          async read(visit) {
            log.forEach((event) => visit(event))
          },
          async append(event) {
            if (create) log.push(event)
          },
        })
      },
    }
    return store
  },
}
createForum({ forumDir: '/abs/forum', adapter: memoryAdapter })
export const noCursor: ForumAdapter = {
  // @ts-expect-error: read resolves to the next cursor
  async open() {
    return { identity: 'x', async read() {}, async write(_options, fn) { return fn({ async read() {}, async append() {} }) } }
  },
}

// Views and targets of the /forum readers.
export const views: ForumView[] = [{ kind: 'topics' }, { kind: 'messages', topicId: 't', after: 'c' }, { kind: 'read', messageId: 'm' }]
export const command: string | null = textCommand({ kind: 'read', messageId: 'm' })
// @ts-expect-error: reading needs a message ID
textCommand({ kind: 'read' })
// @ts-expect-error: the topic list has no topic
views.push({ kind: 'topics', topicId: 't' })
export const target: ForumTarget = { forumDir: '/abs/forum', generated: false, status: 'on' }
// @ts-expect-error: only a generated directory is a project pin
export const pinned: ForumTarget = { forumDir: '/abs/forum', generated: false, project: true, status: 'on' }
export const listing: string = formatTopicList({ target, page: { items: [topicValue], next_cursor: 'c' } })
export function browse(forum: Forum): void {
  const reader: BrowserForum = forum
  createBrowser({ forum: reader, target, view: { kind: 'messages', topicId: 't' } })
  // @ts-expect-error: the browser needs a view
  createBrowser({ forum: reader, target })
}

// The CLI entry point and the compatibility wrappers.
export const exitCode: Promise<number> = main(['topic', 'list'], { PI_FORUM_DIR: '/abs/forum' }, { stdout: { write: (chunk: string) => void chunk } })
export const listed: Promise<Page<Topic>> = storage.listTopics('/abs/forum', { limit: 5 })
// @ts-expect-error: arguments are strings
main([1])
const env: Environment = { PI_FORUM_DIR: '/abs/forum', PI_SESSION_ID: undefined }
const writer: OutputWriter = { write: (chunk: string) => void chunk }
const bind: ForumFactory = createForum
export const mainOptions: MainOptions = { createForum: bind, stdout: writer, stderr: undefined }
export const withOptions: Promise<number> = main(['--help'], env, mainOptions)
// @ts-expect-error: main only reads the environment
env.PI_FORUM_DIR = '/elsewhere'
// @ts-expect-error: output is written as strings
main([], env, { stdout: { write: (chunk: number) => void chunk } })
// @ts-expect-error: a forum factory returns a Forum
main([], env, { createForum: () => ({}) })

// Records: the limits, input checks and canonical events behind the API.
export const labelLimit: 256 = MAX_LABEL_CHARS
export const bodyLimit: number = MAX_BODY_BYTES
// @ts-expect-error: the label limit is exactly 256
export const otherLimit: 255 = MAX_LABEL_CHARS
export const id: string = checkId('t-1' as unknown, 'topic ID')
// Inputs are unchecked: any value may be passed for a known field, and is checked at run time.
const raw: Unchecked<CreateTopicInput> = { title: 42, author: null }
export const fields: TopicFields = topicInput(raw)
export const created: Topic = newTopic(fields)
// @ts-expect-error: not a field of a topic input
topicInput({ titel: 'Plan' })
// @ts-expect-error: checked topic fields have an author
newTopic({ title: 'Plan' })
// @ts-expect-error: optional record fields are omitted, never undefined
export const undefinedOrigin: Topic = { ...topicValue, origin_session_id: undefined }
export function eventBody(value: unknown): string {
  const event = canonicalEvent(value)
  if (event.type === 'message_posted') return event.data.body
  // @ts-expect-error: a topic has no body
  return event.data.body
}

// Cursors of the JSONL adapter: opaque strings, checked against a forum and a log snapshot.
export const cursor: string = encodeCursor('forum-id', 0)
export const offset: Promise<number> = decodeCursor(cursor, 'forum-id', 10, async (position: number) => (position < 10 ? 10 : undefined))
export const cursorData: CursorData = { v: 1, forum: 'forum-id', offset: 0 }
// @ts-expect-error: a byte read resolves to a byte or undefined
decodeCursor(cursor, 'forum-id', 10, async () => 'x')
// @ts-expect-error: version 1 is the only cursor format
export const futureCursor: CursorData = { v: 2, forum: 'forum-id', offset: 0 }

// A store's write resolves to what its function returns.
export function writeCount(store: ForumStore): Promise<number> {
  const count: Promise<number> = store.write({ onWarning: () => {} }, async (transaction) => {
    await transaction.append({ type: 'topic_created', data: topicValue })
    return 1
  })
  // @ts-expect-error: the write resolves to a number here
  const text: Promise<string> = store.write({ onWarning: () => {} }, async () => 1)
  void text
  return count
}
