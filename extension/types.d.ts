import type { BeforeAgentStartEvent, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import type { Message, Page, Topic } from '../src/types.js';
import type { Browser, BrowserForum } from './browser-state.js';
export type PreferenceScope = 'user' | 'project';
export interface PreferenceContext {
    readonly cwd: ExtensionContext['cwd'];
    readonly isProjectTrusted?: ExtensionContext['isProjectTrusted'] | undefined;
}
export interface PreferenceFs {
    readFileSync(path: string, encoding: 'utf8'): string;
    mkdirSync(path: string, options: {
        recursive: true;
    }): unknown;
    openSync(path: string, flags: 'wx'): number;
    writeFileSync(fd: number, data: string): void;
    fsyncSync(fd: number): void;
    closeSync(fd: number): void;
    renameSync(oldPath: string, newPath: string): void;
    unlinkSync(path: string): void;
}
export interface PreferenceStoreOptions {
    getAgentDir: () => string;
    fs?: PreferenceFs | undefined;
}
export type PreferenceIgnoredCode = 'no-cwd' | 'untrusted' | 'trust-unavailable';
export type PreferenceErrorCode = 'agent-dir-unavailable' | 'unreadable' | 'malformed' | 'invalid';
export type PreferenceUpdateErrorCode = PreferenceIgnoredCode | PreferenceErrorCode | 'write-failed';
export interface PreferenceProblem<C extends string = PreferenceUpdateErrorCode> {
    code: C;
    message: string;
}
export type ScopeState<S extends PreferenceScope = PreferenceScope> = {
    scope: S;
    path: string;
    exists: boolean;
    enabled: boolean | undefined;
    ignored: null;
    error: null;
} | {
    scope: S;
    path: string | null;
    exists: false;
    enabled: undefined;
    ignored: PreferenceProblem<PreferenceIgnoredCode>;
    error: null;
} | {
    scope: S;
    path: string | null;
    exists: boolean;
    enabled: undefined;
    ignored: null;
    error: PreferenceProblem<PreferenceErrorCode>;
};
export type LoadedPreferences = ({
    enabled: boolean;
    source: PreferenceScope;
} | {
    enabled: undefined;
    source: null;
}) & {
    user: ScopeState<'user'>;
    project: ScopeState<'project'>;
};
export interface SavedDefault<V extends boolean | undefined = boolean | undefined> {
    ok: true;
    scope: PreferenceScope;
    path: string;
    enabled: V;
    changed: boolean;
}
export interface FailedDefault {
    ok: false;
    scope: PreferenceScope;
    path: string | null;
    error: PreferenceProblem;
}
export type PreferenceUpdate<V extends boolean | undefined = boolean | undefined> = SavedDefault<V> | FailedDefault;
export interface PreferenceStore {
    load(ctx?: PreferenceContext): LoadedPreferences;
    set(scope: PreferenceScope, enabled: boolean, ctx?: PreferenceContext): PreferenceUpdate<boolean>;
    reset(scope: PreferenceScope, ctx?: PreferenceContext): PreferenceUpdate<undefined>;
}
export type BindingStatus = 'on' | 'off' | 'unavailable';
export type ForumBinding = {
    forumDir: string;
    generated: false;
    project?: undefined;
} | {
    forumDir: string;
    generated: true;
    project?: boolean | undefined;
};
export type ForumTarget = ForumBinding & {
    resolved?: string | undefined;
    status: BindingStatus;
    warning?: string | null | undefined;
};
export interface WarningSummary {
    readonly items: readonly string[];
    readonly omitted?: number | undefined;
}
export type ReadWarnings = readonly string[] | WarningSummary;
export type TopicsView = {
    readonly kind: 'topics';
    readonly topicId?: undefined;
    readonly messageId?: undefined;
    readonly after?: string | undefined;
};
export type MessagesView = {
    readonly kind: 'messages';
    readonly topicId?: string | undefined;
    readonly messageId?: undefined;
    readonly after?: string | undefined;
};
export type ReadView = {
    readonly kind: 'read';
    readonly topicId?: undefined;
    readonly messageId: string;
    readonly after?: undefined;
};
export type ListView = TopicsView | MessagesView;
export type ForumView = ListView | ReadView;
export type ViewKind = ForumView['kind'];
export type VisibleWidth = (text: string) => number;
export interface TopicListRequest {
    target: ForumTarget;
    page: Page<Topic>;
    after?: string | undefined;
    warnings?: ReadWarnings | undefined;
}
export interface MessageListRequest {
    target: ForumTarget;
    topicId?: string | undefined;
    page: Page<Message>;
    after?: string | undefined;
    warnings?: ReadWarnings | undefined;
}
export interface MessageRequest {
    target: ForumTarget;
    message: Message;
    warnings?: ReadWarnings | undefined;
    visibleWidth?: VisibleWidth | undefined;
}
export interface BrowserContext {
    readonly ui: Pick<ExtensionUIContext, 'custom'>;
}
export type BrowserReport = (message: string, type?: Parameters<ExtensionUIContext['notify']>[1]) => void;
export interface OpenBrowserRequest {
    browser: Browser;
    forum: BrowserForum;
    target: ForumTarget;
    view: ForumView;
    ctx: BrowserContext;
    signal: AbortSignal;
    report: BrowserReport;
}
export type OpenBrowser = (request: OpenBrowserRequest) => Promise<void>;
export type NotifyType = NonNullable<Parameters<ExtensionUIContext['notify']>[1]>;
export interface RuntimeContext extends PreferenceContext, BrowserContext {
    readonly mode: ExtensionContext['mode'];
    readonly hasUI: ExtensionContext['hasUI'];
    readonly ui: Pick<ExtensionUIContext, 'notify' | 'custom'>;
    readonly sessionManager: Pick<ExtensionContext['sessionManager'], 'getSessionId'>;
}
export interface PromptEvent {
    readonly systemPromptOptions: Pick<BeforeAgentStartEvent['systemPromptOptions'], 'sections'>;
}
