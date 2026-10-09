export interface Topic {
    id: string;
    title: string;
    created_by: string;
    created_at: string;
    origin_session_id?: string;
}
export interface Message {
    id: string;
    topic_id: string;
    author: string;
    body: string;
    created_at: string;
    origin_session_id?: string;
    reply_to?: string;
}
export interface TopicCreatedEvent {
    type: 'topic_created';
    data: Topic;
}
export interface MessagePostedEvent {
    type: 'message_posted';
    data: Message;
}
export type ForumEvent = TopicCreatedEvent | MessagePostedEvent;
export type ForumEventType = ForumEvent['type'];
export interface Page<T> {
    items: T[];
    next_cursor: string;
}
export type ForumErrorCode = 'INVALID_INPUT' | 'INVALID_CURSOR' | 'NOT_FOUND' | 'FORUM_UNAVAILABLE' | 'LOCK_TIMEOUT' | 'INCOMPLETE_LOG' | 'WRITE_FAILED' | 'PARTIAL_WRITE' | 'ABORTED';
export type WarningHandler = (message: string) => void;
export type EventVisitor = (event: ForumEvent) => boolean | void;
export interface ReadCallOptions {
    onWarning?: WarningHandler | undefined;
    signal?: AbortSignal | null | undefined;
}
export interface ListOptions extends ReadCallOptions {
    after?: string | null | undefined;
    limit?: number | null | undefined;
}
export interface ListMessagesOptions extends ListOptions {
    topicId?: string | null | undefined;
}
export interface WriteCallOptions {
    onWarning?: WarningHandler | undefined;
}
export interface CreateTopicInput {
    title: string;
    author: string;
    body?: string | null | undefined;
    originSessionId?: string | null | undefined;
}
export interface PostMessageInput {
    topicId: string;
    author: string;
    body: string;
    originSessionId?: string | null | undefined;
    replyTo?: string | null | undefined;
}
export interface CreateTopicResult {
    topic: Topic;
    message: Message | null;
}
export interface CreateForumOptions {
    forumDir: string;
    adapter?: ForumAdapter | undefined;
    createOnRead?: boolean | undefined;
}
export interface Forum {
    readonly forumDir: string;
    readonly resolved: string | undefined;
    listTopics(options?: ListOptions): Promise<Page<Topic>>;
    listMessages(options?: ListMessagesOptions): Promise<Page<Message>>;
    getTopic(topicId: string, options?: ReadCallOptions): Promise<Topic>;
    getMessage(messageId: string, options?: ReadCallOptions): Promise<Message>;
    createTopic(input: CreateTopicInput, options?: WriteCallOptions): Promise<CreateTopicResult>;
    postMessage(input: PostMessageInput, options?: WriteCallOptions): Promise<Message>;
}
export interface OpenOptions {
    forumDir: string;
    create: boolean;
    identity?: string | undefined;
}
export interface StoreReadOptions {
    after?: string | undefined;
    onWarning: WarningHandler;
    signal?: AbortSignal | undefined;
}
export interface StoreWriteOptions {
    onWarning: WarningHandler;
}
export interface WriteTransaction {
    read(visit: EventVisitor): Promise<void>;
    append(event: ForumEvent): Promise<void>;
}
export interface ForumStore {
    readonly identity: string;
    read(options: StoreReadOptions, visit: EventVisitor): Promise<string>;
    write<T>(options: StoreWriteOptions, fn: (transaction: WriteTransaction) => Promise<T>): Promise<T>;
}
export interface ForumAdapter {
    open(options: OpenOptions): Promise<ForumStore>;
}
