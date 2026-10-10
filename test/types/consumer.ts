// Type-regression fixture: how a consumer of the installed package uses its public types, compiled
// by test/types.test.ts against the packed declarations (node_modules/pi-forum), never the sources.
// It imports pi-forum by package name, so it is the one file under test/ that npm run typecheck
// leaves out (see tsconfig.tooling.json); the test compiles it instead. The plain statements must
// compile. Each @ts-expect-error marks a use the declarations must reject;
// if a type widened (to any, say), the unused directive fails the compile.
import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { createBrowser, type BrowserForum } from 'pi-forum/extension/browser-state.js'
import { createBrowserOpener, type BrowserTui } from 'pi-forum/extension/browser.js'
import { createEntryRenderer, ENTRY_TYPE, entryData } from 'pi-forum/extension/entry-renderer.js'
import piForum from 'pi-forum/extension/index.js'
import { formatTopicList, textCommand } from 'pi-forum/extension/output.js'
import { createPreferenceStore } from 'pi-forum/extension/preferences.js'
import { createForumRuntime } from 'pi-forum/extension/runtime.js'
import type { ForumTarget, ForumView, PromptEvent, RuntimeContext } from 'pi-forum/extension/types.js'
import { jsonlAdapter } from 'pi-forum/src/backends/jsonl.js'
import { main } from 'pi-forum/src/cli.js'
import { createForum, ForumError } from 'pi-forum/src/forum.js'
import * as storage from 'pi-forum/src/storage.js'
import type { Forum, ForumAdapter, ForumErrorCode, ForumEvent, ForumStore, Message, Page, Topic } from 'pi-forum/src/types.js'

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
  return err.code
}

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
