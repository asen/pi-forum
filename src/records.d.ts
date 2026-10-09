import type { CreateTopicInput, ForumErrorCode, ForumEvent, Message, PostMessageInput, Topic } from './types.js';
export declare const MAX_LABEL_CHARS = 256;
export declare const MAX_BODY_BYTES: number;
export declare class ForumError extends Error {
    code: ForumErrorCode;
    topic?: Topic;
    constructor(code: ForumErrorCode, message: string, options?: ErrorOptions);
}
export declare function throwIfAborted(signal: AbortSignal | null | undefined): void;
export declare function errorMessage(err: unknown): unknown;
export declare function checkId(value: unknown, name: string): string;
export type Unchecked<T> = {
    [K in keyof T]?: unknown;
};
export interface TopicFields {
    title: string;
    author: string;
    body?: string | undefined;
    originSessionId?: string | undefined;
}
export interface MessageFields {
    topicId: string;
    author: string;
    body: string;
    originSessionId?: string | undefined;
    replyTo?: string | undefined;
}
export declare function topicInput({ title, author, body: topicBody, originSessionId, }?: Unchecked<CreateTopicInput>): TopicFields;
export declare function messageInput({ topicId, author, body: messageBody, originSessionId, replyTo, }?: Unchecked<PostMessageInput>): MessageFields;
export declare function newTopic({ title, author, originSessionId }: TopicFields): Topic;
export declare function newMessage({ topicId, author, body, originSessionId, replyTo }: MessageFields): Message;
export declare function canonicalEvent(event: unknown): ForumEvent;
