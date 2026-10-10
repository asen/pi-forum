// Navigation and request state for one forum browser, independent of how it is drawn. A renderer
// reads browser.state, calls the actions, redraws on onChange or a subscribe() listener, and ends
// when browser.done settles.
//
// Views form a stack: topics -> a topic's messages -> one message; a browser may also start at
// messages (one topic or all activity) or at a message. List views keep only their current page
// and the start cursors of the pages visited to reach it; Previous and Refresh reread. Back
// restores the parent view with its page and selection, and closes the browser at the root.
//
// Reads go through the bound forum client with the browser's own AbortController: a new load
// aborts the one it supersedes, and closing aborts the current one. Each load has a generation
// token, so completions and warnings from superseded or aborted loads are ignored. The lifetime
// signal (the runtime's per-selection signal) closes the browser when it aborts; the browser never
// aborts or reuses any other signal.

import type { Forum, Message, Page, ReadCallOptions, Topic } from '../src/types.d.mts'
import type { ForumTarget, ForumView } from './types.ts'

export const PAGE_SIZE = 20
export const WARNING_LIMIT = 20

// What the browser reads through: the bound forum client (src/forum.mjs), which knows where it
// resolved once it has read.
export interface BrowserForum extends Pick<Forum, 'listTopics' | 'listMessages' | 'getMessage'> {
  readonly resolved?: Forum['resolved'] | undefined
}

export interface BrowserOptions {
  forum: BrowserForum
  target: ForumTarget
  // Where the browser starts; a list view's after is not used.
  view: ForumView
  // The lifetime signal; its abort closes the browser as 'discarded'.
  signal?: AbortSignal | null | undefined
  pageSize?: number | undefined
  warningLimit?: number | undefined
  onChange?: (() => void) | undefined
}

// The state of a view's current read.
export type BrowserStatus = 'loading' | 'ready' | 'error'

// What a failed view offers next.
export type BrowserErrorAction = 'retry' | 'restart' | 'back'

// The error a view shows. code and message are the thrown value's, read as err?.code ?? 'ERROR' and
// err?.message ?? String(err): a ForumError's code and message, or whatever another value carried.
export interface BrowserError {
  readonly code: unknown
  readonly message: unknown
  readonly forumDir: string
  readonly actions: readonly BrowserErrorAction[]
}

// The damaged-record warnings of the current read: the first warningLimit of them, the rest counted.
export interface BrowserWarnings {
  readonly items: readonly string[]
  readonly omitted: number
}

// Which actions apply now.
export interface BrowserActions {
  readonly open: boolean
  readonly previous: boolean
  readonly next: boolean
  readonly back: boolean
  readonly refresh: boolean
  readonly retry: boolean
  readonly restart: boolean
  readonly close: boolean
}

// The browsed directory, with where the client resolved (undefined until its first successful read).
export type BrowserTarget = ForumTarget & { readonly resolved: string | undefined }

// The view shown. A messages view without a topicId shows activity across the forum; topic is the
// topic it was opened from, if any.
export interface TopicsViewState {
  readonly kind: 'topics'
}
export interface MessagesViewState {
  readonly kind: 'messages'
  readonly topicId: string | undefined
  readonly topic: Topic | undefined
}
export interface MessageViewState {
  readonly kind: 'message'
  readonly messageId: string
}
export type BrowserViewState = TopicsViewState | MessagesViewState | MessageViewState
export type ListViewState = TopicsViewState | MessagesViewState

// A list view's current page. items are empty until its first read and after a failed one; caughtUp
// is a ready page shorter than the page size.
export interface BrowserPage<T> {
  readonly index: number
  readonly items: readonly T[]
  readonly selection: number
  readonly caughtUp: boolean
}

interface BrowserStateFields {
  readonly closed: boolean
  readonly target: BrowserTarget
  readonly atRoot: boolean
  readonly warnings: BrowserWarnings
  readonly actions: BrowserActions
}

// A topics view pages topics and a messages view messages; a message view has the message once read
// (kept while it is reread) and no page.
type ShownState =
  | { readonly view: TopicsViewState; readonly page: BrowserPage<Topic>; readonly message: null }
  | { readonly view: MessagesViewState; readonly page: BrowserPage<Message>; readonly message: null }
  | { readonly view: MessageViewState; readonly page: null; readonly message: Message | null }

type LoadedState =
  | { readonly status: 'loading' | 'ready'; readonly error: null }
  | { readonly status: 'error'; readonly error: BrowserError }

// What a renderer draws: a fresh snapshot of the browser on each read of browser.state.
export type BrowserState = BrowserStateFields & ShownState & LoadedState
export type ListBrowserState = Exclude<BrowserState, { readonly view: MessageViewState }>
export type MessageBrowserState = Extract<BrowserState, { readonly view: MessageViewState }>

// The controller createBrowser returns.
export interface Browser {
  readonly closed: boolean
  // Why the browser closed: 'closed' (Esc), 'back' (Back at the root), 'discarded' (the selection
  // ended), or whatever the caller passed to close(); null while open.
  readonly closeReason: string | null
  // Resolves with the close reason once the browser closes.
  readonly done: Promise<string>
  // Calls listener after each state change until it unsubscribes or the browser closes.
  subscribe(listener: () => void): () => void
  readonly state: BrowserState
  start(): Promise<void>
  select(index: number): void
  moveSelection(delta: number): void
  open(): Promise<void>
  next(): Promise<void>
  previous(): Promise<void>
  refresh(): Promise<void>
  retry(): Promise<void>
  restart(): Promise<void>
  back(): void
  close(reason?: string): void
}

// Frames: one per view on the stack, updated in place as its reads settle.

interface Warnings {
  items: string[]
  omitted: number
}

// A read in flight keeps what the view last showed; a ready list has its items and the cursor after
// them, and a failed read clears them.
type ListLoad<T> =
  | { status: 'loading'; error: null; items: T[] | null }
  | { status: 'ready'; error: null; items: T[]; nextCursor: string }
  | { status: 'error'; error: BrowserError; items: null }

type MessageLoad =
  | { status: 'loading'; error: null; message: Message | null }
  | { status: 'ready'; error: null; message: Message }
  | { status: 'error'; error: BrowserError; message: null }

interface ListFields<K extends string> {
  kind: K
  // Start cursors of the pages visited, up to the current one.
  cursors: (string | undefined)[]
  pageIndex: number
  nextCursor: string | null
  selection: number
  warnings: Warnings
}

type TopicsFrame = ListFields<'topics'> & { topicId: undefined; topic: undefined } & ListLoad<Topic>
type MessagesFrame = ListFields<'messages'> & { topicId: string | undefined; topic: Topic | undefined } & ListLoad<Message>
type MessageFrame = { kind: 'message'; messageId: string; warnings: Warnings } & MessageLoad
type ListFrame = TopicsFrame | MessagesFrame
type Frame = ListFrame | MessageFrame
type ReadyListFrame = Extract<ListFrame, { status: 'ready' }>

// A list frame's read resolves with a page of its items, a message frame's with the message.
type ReadResult = Page<Topic> | Page<Message> | Message

// The snapshot's fields without the correlations BrowserState adds, as the state getter assembles them.
type StateFields = { [K in Exclude<keyof BrowserState, 'page'>]: BrowserState[K] } & {
  readonly page: BrowserPage<Topic | Message> | null
}

const isList = (frame: Frame): frame is ListFrame => frame.kind !== 'message'

export function createBrowser({
  forum,
  target,
  view,
  signal,
  pageSize = PAGE_SIZE,
  warningLimit = WARNING_LIMIT,
  onChange = () => {},
}: BrowserOptions): Browser {
  const own = new AbortController()
  const frames: Frame[] = [initialFrame(view)]
  let generation = 0
  let current: AbortController | null = null
  let closeReason: string | null = null
  let resolveDone: (reason: string) => void
  const done = new Promise<string>((resolve) => {
    resolveDone = resolve
  })
  const onLifetimeEnd = () => close('discarded')
  const listeners = new Set<() => void>()

  // The stack always keeps its root: Back there closes the browser instead of popping it.
  const top = () => frames.at(-1)!

  function notify() {
    if (closeReason) return
    onChange()
    for (const listener of [...listeners]) listener()
  }

  // Starts reading the top view's current page or message; resolves once it settles or is superseded.
  function load(): Promise<void> {
    if (closeReason) return Promise.resolve()
    current?.abort()
    const controller = new AbortController()
    current = controller
    const token = ++generation
    const frame = top()
    const warnings: Warnings = { items: [], omitted: 0 }
    frame.status = 'loading'
    frame.error = null
    frame.warnings = warnings
    const live = () => token === generation && !closeReason
    const options = {
      signal: AbortSignal.any([own.signal, controller.signal]),
      onWarning(message: string) {
        if (!live()) return
        if (warnings.items.length < warningLimit) warnings.items.push(message)
        else warnings.omitted++
        notify()
      },
    }
    notify()
    return Promise.resolve()
      .then(() => read(frame, options))
      .then(
        (result) => {
          if (!live()) return
          if (isList(frame)) {
            // read() resolves a list frame with a page of its own items.
            const page = result as Page<Topic> | Page<Message>
            frame.items = page.items
            frame.nextCursor = page.next_cursor
            frame.selection = Math.max(0, Math.min(frame.selection, page.items.length - 1))
          } else {
            frame.message = result as Message
          }
          frame.status = 'ready'
          notify()
        },
        (err: unknown) => {
          if (!live()) return
          if (isList(frame)) frame.items = null
          else frame.message = null
          frame.status = 'error'
          frame.error = describeError(err, frame, target)
          notify()
        },
      )
      .finally(() => {
        if (current === controller) current = null
      })
  }

  function read(frame: Frame, options: ReadCallOptions): Promise<ReadResult> {
    const page = { after: isList(frame) ? frame.cursors[frame.pageIndex] : undefined, limit: pageSize }
    if (frame.kind === 'topics') return forum.listTopics({ ...options, ...page })
    if (frame.kind === 'messages') return forum.listMessages({ ...options, ...page, topicId: frame.topicId })
    return forum.getMessage(frame.messageId, options)
  }

  // Abandons any load in flight, e.g. before showing a view that is already loaded.
  function supersede() {
    generation++
    current?.abort()
    current = null
  }

  function close(reason = 'closed') {
    if (closeReason) return
    closeReason = reason
    generation++
    own.abort()
    current = null
    listeners.clear()
    signal?.removeEventListener('abort', onLifetimeEnd)
    resolveDone(reason)
  }

  function canNext(frame: Frame) {
    return isList(frame) && frame.status === 'ready' && frame.items.length === pageSize
  }

  const browser: Browser = {
    get closed() {
      return closeReason !== null
    },
    // Why the browser closed: 'closed' (Esc), 'back' (Back at the root), 'discarded' (the selection
    // ended), or whatever the caller passed to close().
    get closeReason() {
      return closeReason
    },
    // Resolves with the close reason once the browser closes.
    done,
    // Calls listener after each state change until it unsubscribes or the browser closes.
    subscribe(listener) {
      if (closeReason) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    // What a renderer draws; a fresh snapshot each time.
    get state() {
      const frame = top()
      const list = isList(frame)
      // Each frame keeps the correlations BrowserState adds: its view and page or message match its
      // kind, and only a failed read has an error.
      return {
        closed: closeReason !== null,
        // Where the client resolved is known after its first successful read.
        target: { ...target, resolved: forum.resolved },
        atRoot: frames.length === 1,
        view: viewOf(frame),
        status: frame.status,
        error: frame.error,
        warnings: { items: [...frame.warnings.items], omitted: frame.warnings.omitted },
        page: list
          ? {
              index: frame.pageIndex,
              items: frame.items ?? [],
              selection: frame.selection,
              caughtUp: frame.status === 'ready' && frame.items.length < pageSize,
            }
          : null,
        message: list ? null : frame.message,
        actions: {
          open: list && frame.status === 'ready' && frame.items.length > 0,
          previous: list && frame.pageIndex > 0,
          next: canNext(frame),
          back: true,
          refresh: frame.status !== 'error',
          retry: frame.status === 'error' && frame.error.code !== 'INVALID_CURSOR',
          restart: list && (frame.pageIndex > 0 || frame.error?.code === 'INVALID_CURSOR'),
          close: true,
        },
      } satisfies StateFields as BrowserState
    },

    start() {
      return load()
    },

    select(index) {
      const frame = top()
      if (closeReason || !isList(frame) || !frame.items?.length) return
      frame.selection = Math.max(0, Math.min(index, frame.items.length - 1))
      notify()
    },

    moveSelection(delta) {
      const frame = top()
      // A message view has no selection (undefined + delta is NaN), and select ignores it.
      browser.select((isList(frame) ? frame.selection : NaN) + delta)
    },

    // Opens the selected row: a topic's messages, or a message's complete record.
    open() {
      const frame = top()
      if (closeReason || !browser.state.actions.open) return Promise.resolve()
      // Open applies only to a ready list, which has a row at its selection.
      const { kind, items, selection } = frame as ReadyListFrame
      frames.push(
        kind === 'topics'
          ? listFrame({ kind: 'messages', topicId: items[selection]!.id, topic: items[selection]! })
          : { kind: 'message', messageId: items[selection]!.id, message: null, ...pending() },
      )
      return load()
    },

    next() {
      const frame = top()
      if (closeReason || !canNext(frame)) return Promise.resolve()
      // canNext: a ready list, whose nextCursor is the one its read returned.
      const list = frame as ListFrame & { nextCursor: string }
      list.cursors.push(list.nextCursor)
      list.pageIndex++
      list.selection = 0
      list.items = null
      return load()
    },

    previous() {
      const frame = top()
      if (closeReason || !isList(frame) || frame.pageIndex === 0) return Promise.resolve()
      frame.cursors.pop()
      frame.pageIndex--
      frame.selection = 0
      frame.items = null
      return load()
    },

    // Rereads the current page from its start cursor, forgetting pages after it, or the message.
    refresh() {
      if (closeReason) return Promise.resolve()
      const frame = top()
      if (isList(frame)) frame.cursors.length = frame.pageIndex + 1
      return load()
    },

    retry() {
      return browser.refresh()
    },

    // Starts the list again from its first page, e.g. after INVALID_CURSOR.
    restart() {
      const frame = top()
      if (closeReason || !isList(frame)) return Promise.resolve()
      frame.cursors = [undefined]
      frame.pageIndex = 0
      frame.selection = 0
      frame.items = null
      return load()
    },

    // Returns to the parent view as it was left; at the root, closes the browser.
    back() {
      if (closeReason) return
      if (frames.length === 1) {
        close('back')
        return
      }
      supersede()
      frames.pop()
      if (top().status === 'loading') load()
      else notify()
    },

    close,
  }

  if (signal?.aborted) close('discarded')
  else signal?.addEventListener('abort', onLifetimeEnd, { once: true })
  return browser
}

function pending(): { status: 'loading'; error: null; warnings: Warnings } {
  return { status: 'loading', error: null, warnings: { items: [], omitted: 0 } }
}

function listFrame(view: { kind: 'topics' }): TopicsFrame
function listFrame(view: { kind: 'messages'; topicId: string | undefined; topic?: Topic | undefined }): MessagesFrame
function listFrame({ kind, topicId, topic }: { kind: ListFrame['kind']; topicId?: string | undefined; topic?: Topic | undefined }): ListFrame {
  // The overloads pair kind with its topicId and topic.
  return {
    kind,
    topicId,
    topic,
    // Start cursors of the pages visited, up to the current one.
    cursors: [undefined],
    pageIndex: 0,
    items: null,
    nextCursor: null,
    selection: 0,
    ...pending(),
  } as ListFrame
}

function initialFrame(view: ForumView): Frame {
  if (view.kind === 'topics') return listFrame({ kind: 'topics' })
  if (view.kind === 'messages') return listFrame({ kind: 'messages', topicId: view.topicId })
  return { kind: 'message', messageId: view.messageId, message: null, ...pending() }
}

// Messages views without a topicId show activity across the forum; each record has its topic_id.
function viewOf(frame: Frame): BrowserViewState {
  if (frame.kind === 'topics') return { kind: 'topics' }
  if (frame.kind === 'messages') return { kind: 'messages', topicId: frame.topicId, topic: frame.topic }
  return { kind: 'message', messageId: frame.messageId }
}

// The error a view shows, naming the forum it read and what can be done next.
function describeError(err: unknown, frame: Frame, target: ForumTarget): BrowserError {
  const code = errorField(err, 'code') ?? 'ERROR'
  return {
    code,
    message: errorField(err, 'message') ?? String(err),
    forumDir: target.forumDir,
    actions:
      code === 'INVALID_CURSOR'
        ? ['restart', 'back']
        : ['retry', ...(frame.kind !== 'message' && frame.pageIndex > 0 ? (['restart'] as const) : []), 'back'],
  }
}

// err?.[name] for any thrown value, read exactly as JavaScript reads it: undefined for null and
// undefined, and otherwise the value's own or inherited property, if any.
function errorField(err: unknown, name: 'code' | 'message'): unknown {
  // Asserted only to allow the property access; no value other than null or undefined fails it.
  return err == null ? undefined : (err as { readonly [key: string]: unknown })[name]
}
