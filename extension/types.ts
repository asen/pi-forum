// Shared shapes of the Pi extension: what it reads from the host, the saved activation defaults, the
// browsed forum binding and the views it reads. Types only; the emitted module is empty. Host types
// come from the installed Pi as type-only imports, so nothing here loads Pi at runtime.

import type { BeforeAgentStartEvent, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { Message, Page, Topic } from '../src/types.js'
import type { Browser, BrowserForum } from './browser-state.js'

// Saved defaults

export type PreferenceScope = 'user' | 'project'

// What the preference store reads from Pi's context. isProjectTrusted may be absent, as on a Pi that
// does not report project trust; project defaults then fail closed. The store still checks both
// values at runtime, so a context that breaks these types is reported rather than trusted.
export interface PreferenceContext {
  readonly cwd: ExtensionContext['cwd']
  readonly isProjectTrusted?: ExtensionContext['isProjectTrusted'] | undefined
}

// The synchronous node:fs calls the store makes, in the forms it makes them; node:fs by default.
export interface PreferenceFs {
  readFileSync(path: string, encoding: 'utf8'): string
  mkdirSync(path: string, options: { recursive: true }): unknown
  openSync(path: string, flags: 'wx'): number
  writeFileSync(fd: number, data: string): void
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

export interface PreferenceStoreOptions {
  // Pi's agent directory, which holds the user file; a throw makes the user scope unusable.
  getAgentDir: () => string
  fs?: PreferenceFs | undefined
}

// A scope file was not consulted (project only).
export type PreferenceIgnoredCode = 'no-cwd' | 'untrusted' | 'trust-unavailable'
// A scope file was consulted and could not be used.
export type PreferenceErrorCode = 'agent-dir-unavailable' | 'unreadable' | 'malformed' | 'invalid'
// An update failed: for one of the reasons above, or while writing.
export type PreferenceUpdateErrorCode = PreferenceIgnoredCode | PreferenceErrorCode | 'write-failed'

export interface PreferenceProblem<C extends string = PreferenceUpdateErrorCode> {
  code: C
  message: string
}

// One scope as loaded. path is null when it cannot be known (no-cwd, agent-dir-unavailable). enabled
// is the saved boolean, or undefined to inherit, and is only ever set on a scope that was used.
export type ScopeState<S extends PreferenceScope = PreferenceScope> =
  | {
      scope: S
      path: string
      exists: boolean
      enabled: boolean | undefined
      ignored: null
      error: null
    }
  | {
      scope: S
      path: string | null
      exists: false
      enabled: undefined
      ignored: PreferenceProblem<PreferenceIgnoredCode>
      error: null
    }
  | {
      scope: S
      path: string | null
      exists: boolean
      enabled: undefined
      ignored: null
      error: PreferenceProblem<PreferenceErrorCode>
    }

// Both scopes as loaded, with the effective saved default: the project's if set, else the user's, else
// none (undefined, from no source) to inherit the built-in default.
export type LoadedPreferences = (
  | { enabled: boolean; source: PreferenceScope }
  | { enabled: undefined; source: null }
) & {
  user: ScopeState<'user'>
  project: ScopeState<'project'>
}

// A save (enabled is a boolean) or reset (enabled is undefined) that succeeded: enabled is the scope's
// saved value afterward and changed whether the file was written.
export interface SavedDefault<V extends boolean | undefined = boolean | undefined> {
  ok: true
  scope: PreferenceScope
  path: string
  enabled: V
  changed: boolean
}

// A save or reset that changed nothing.
export interface FailedDefault {
  ok: false
  scope: PreferenceScope
  path: string | null
  error: PreferenceProblem
}

export type PreferenceUpdate<V extends boolean | undefined = boolean | undefined> = SavedDefault<V> | FailedDefault

export interface PreferenceStore {
  load(ctx?: PreferenceContext): LoadedPreferences
  set(scope: PreferenceScope, enabled: boolean, ctx?: PreferenceContext): PreferenceUpdate<boolean>
  reset(scope: PreferenceScope, ctx?: PreferenceContext): PreferenceUpdate<undefined>
}

// Forum bindings and the views read from them

// on: agents use the binding; off: they do not; unavailable: it could not be selected, or the
// environment no longer carries it.
export type BindingStatus = 'on' | 'off' | 'unavailable'

// A selected forum directory. generated means the runtime owns the PI_FORUM_DIR value, for a session
// or a project default; project marks the project default, which is always generated.
export type ForumBinding =
  | { forumDir: string; generated: false; project?: undefined }
  | { forumDir: string; generated: true; project?: boolean | undefined }

// The browsed directory as the runtime describes it: the binding, where it resolved once known, the
// current status, and the reason the binding became unavailable, if it did.
export type ForumTarget = ForumBinding & {
  resolved?: string | undefined
  status: BindingStatus
  warning?: string | null | undefined
}

// The damaged-record warnings of one read: all of them, or the first items with the rest counted.
export interface WarningSummary {
  readonly items: readonly string[]
  readonly omitted?: number | undefined
}
export type ReadWarnings = readonly string[] | WarningSummary

// What a view reads: a topic list, a message list (in one topic, or across the forum when topicId is
// undefined) or one message. List views continue after a cursor; a message has none.
export type TopicsView = {
  readonly kind: 'topics'
  readonly topicId?: undefined
  readonly messageId?: undefined
  readonly after?: string | undefined
}
export type MessagesView = {
  readonly kind: 'messages'
  readonly topicId?: string | undefined
  readonly messageId?: undefined
  readonly after?: string | undefined
}
export type ReadView = {
  readonly kind: 'read'
  readonly topicId?: undefined
  readonly messageId: string
  readonly after?: undefined
}
export type ListView = TopicsView | MessagesView
export type ForumView = ListView | ReadView
export type ViewKind = ForumView['kind']

// Terminal columns of printable text; one per grapheme unless the host measures it.
export type VisibleWidth = (text: string) => number

// What the text formatters take: one page of a list read after its cursor, or one message read.
export interface TopicListRequest {
  target: ForumTarget
  page: Page<Topic>
  after?: string | undefined
  warnings?: ReadWarnings | undefined
}

export interface MessageListRequest {
  target: ForumTarget
  topicId?: string | undefined
  page: Page<Message>
  after?: string | undefined
  warnings?: ReadWarnings | undefined
}

export interface MessageRequest {
  target: ForumTarget
  message: Message
  warnings?: ReadWarnings | undefined
  visibleWidth?: VisibleWidth | undefined
}

// The terminal browser

// What a browser opener uses of Pi's context: custom components, which only the terminal UI has.
export interface BrowserContext {
  readonly ui: Pick<ExtensionUIContext, 'custom'>
}

// A notice about the browsed forum, shown while its browser is still open.
export type BrowserReport = (message: string, type?: Parameters<ExtensionUIContext['notify']>[1]) => void

// What the runtime gives an opener: the browser's controller (browser-state.js) on the bound client,
// the target and view it was created for, the context of the command that opened it, the selection's
// lifetime signal, and report.
export interface OpenBrowserRequest {
  browser: Browser
  forum: BrowserForum
  target: ForumTarget
  view: ForumView
  ctx: BrowserContext
  signal: AbortSignal
  report: BrowserReport
}

// Shows the browser and resolves once the interaction has ended; the runtime closes the browser
// afterward either way.
export type OpenBrowser = (request: OpenBrowserRequest) => Promise<void>

// The extension runtime

// A notification's severity, as Pi's ctx.ui.notify takes it.
export type NotifyType = NonNullable<Parameters<ExtensionUIContext['notify']>[1]>

// What the runtime uses of Pi's context, in its event handlers and in /forum: what the preference
// store reads; the mode, of which only the terminal UI ("tui") opens the browser; notifications, used
// only when hasUI; custom components for the browser; and the session ID, for the session default
// directory and the prompt. ExtensionContext and ExtensionCommandContext both provide it.
export interface RuntimeContext extends PreferenceContext, BrowserContext {
  readonly mode: ExtensionContext['mode']
  readonly hasUI: ExtensionContext['hasUI']
  readonly ui: Pick<ExtensionUIContext, 'notify' | 'custom'>
  readonly sessionManager: Pick<ExtensionContext['sessionManager'], 'getSessionId'>
}

// What the runtime changes in before_agent_start: the prompt sections, which it edits in place.
export interface PromptEvent {
  readonly systemPromptOptions: Pick<BeforeAgentStartEvent['systemPromptOptions'], 'sections'>
}
