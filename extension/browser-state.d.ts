import type { Forum, Message, Topic } from '../src/types.js';
import type { ForumTarget, ForumView } from './types.js';
export declare const PAGE_SIZE = 20;
export declare const WARNING_LIMIT = 20;
export interface BrowserForum extends Pick<Forum, 'listTopics' | 'listMessages' | 'getMessage'> {
    readonly resolved?: Forum['resolved'] | undefined;
}
export interface BrowserOptions {
    forum: BrowserForum;
    target: ForumTarget;
    view: ForumView;
    signal?: AbortSignal | null | undefined;
    pageSize?: number | undefined;
    warningLimit?: number | undefined;
    onChange?: (() => void) | undefined;
}
export type BrowserStatus = 'loading' | 'ready' | 'error';
export type BrowserErrorAction = 'retry' | 'restart' | 'back';
export interface BrowserError {
    readonly code: unknown;
    readonly message: unknown;
    readonly forumDir: string;
    readonly actions: readonly BrowserErrorAction[];
}
export interface BrowserWarnings {
    readonly items: readonly string[];
    readonly omitted: number;
}
export interface BrowserActions {
    readonly open: boolean;
    readonly previous: boolean;
    readonly next: boolean;
    readonly back: boolean;
    readonly refresh: boolean;
    readonly retry: boolean;
    readonly restart: boolean;
    readonly close: boolean;
}
export type BrowserTarget = ForumTarget & {
    readonly resolved: string | undefined;
};
export interface TopicsViewState {
    readonly kind: 'topics';
}
export interface MessagesViewState {
    readonly kind: 'messages';
    readonly topicId: string | undefined;
    readonly topic: Topic | undefined;
}
export interface MessageViewState {
    readonly kind: 'message';
    readonly messageId: string;
}
export type BrowserViewState = TopicsViewState | MessagesViewState | MessageViewState;
export type ListViewState = TopicsViewState | MessagesViewState;
export interface BrowserPage<T> {
    readonly index: number;
    readonly items: readonly T[];
    readonly selection: number;
    readonly caughtUp: boolean;
}
interface BrowserStateFields {
    readonly closed: boolean;
    readonly target: BrowserTarget;
    readonly atRoot: boolean;
    readonly warnings: BrowserWarnings;
    readonly actions: BrowserActions;
}
type ShownState = {
    readonly view: TopicsViewState;
    readonly page: BrowserPage<Topic>;
    readonly message: null;
} | {
    readonly view: MessagesViewState;
    readonly page: BrowserPage<Message>;
    readonly message: null;
} | {
    readonly view: MessageViewState;
    readonly page: null;
    readonly message: Message | null;
};
type LoadedState = {
    readonly status: 'loading' | 'ready';
    readonly error: null;
} | {
    readonly status: 'error';
    readonly error: BrowserError;
};
export type BrowserState = BrowserStateFields & ShownState & LoadedState;
export type ListBrowserState = Exclude<BrowserState, {
    readonly view: MessageViewState;
}>;
export type MessageBrowserState = Extract<BrowserState, {
    readonly view: MessageViewState;
}>;
export interface Browser {
    readonly closed: boolean;
    readonly closeReason: string | null;
    readonly done: Promise<string>;
    subscribe(listener: () => void): () => void;
    readonly state: BrowserState;
    start(): Promise<void>;
    select(index: number): void;
    moveSelection(delta: number): void;
    open(): Promise<void>;
    next(): Promise<void>;
    previous(): Promise<void>;
    refresh(): Promise<void>;
    retry(): Promise<void>;
    restart(): Promise<void>;
    back(): void;
    close(reason?: string): void;
}
export declare function createBrowser({ forum, target, view, signal, pageSize, warningLimit, onChange, }: BrowserOptions): Browser;
export {};
