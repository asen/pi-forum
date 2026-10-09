import { randomUUID } from 'node:crypto';
export const MAX_LABEL_CHARS = 256;
export const MAX_BODY_BYTES = 64 * 1024;
export class ForumError extends Error {
    constructor(code, message, options) {
        super(message, options);
        this.name = 'ForumError';
        this.code = code;
    }
}
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new ForumError('ABORTED', 'the operation was aborted', { cause: signal.reason });
}
// err.message for any thrown value, read exactly as JavaScript reads it: null and undefined throw a
// TypeError, and functions, boxed and primitive values give their own or inherited message, if any.
export function errorMessage(err) {
    // Asserted only to allow the property access; no value other than null or undefined fails it.
    return err.message;
}
function invalid(message) {
    return new ForumError('INVALID_INPUT', message);
}
function text(value, name, { maxChars, maxBytes }) {
    if (typeof value !== 'string' || value.trim() === '')
        throw invalid(`${name} must be a non-blank string`);
    if (!value.isWellFormed())
        throw invalid(`${name} must be well-formed Unicode text`);
    if (maxChars !== undefined && [...value].length > maxChars) {
        throw invalid(`${name} must be at most ${maxChars} characters`);
    }
    if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) {
        throw invalid(`${name} must be at most ${maxBytes} bytes of UTF-8`);
    }
    return value;
}
const label = (value, name) => text(value, name, { maxChars: MAX_LABEL_CHARS });
const body = (value) => text(value, 'body', { maxBytes: MAX_BODY_BYTES });
const optional = (value, check, name) => value == null ? undefined : check(value, name);
export function checkId(value, name) {
    return label(value, name);
}
export function topicInput({ title, author, body: topicBody, originSessionId, } = {}) {
    return {
        title: label(title, 'title'),
        author: label(author, 'author'),
        body: optional(topicBody, body, 'body'),
        originSessionId: optional(originSessionId, label, 'originSessionId'),
    };
}
export function messageInput({ topicId, author, body: messageBody, originSessionId, replyTo, } = {}) {
    return {
        topicId: checkId(topicId, 'topicId'),
        author: label(author, 'author'),
        body: body(messageBody),
        originSessionId: optional(originSessionId, label, 'originSessionId'),
        replyTo: optional(replyTo, checkId, 'replyTo'),
    };
}
// Unavailable optional fields are omitted rather than stored as null.
function compact(record) {
    const entries = Object.entries(record);
    // Only undefined optional fields are dropped, which leaves a T.
    return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}
export function newTopic({ title, author, originSessionId }) {
    return compact({
        id: randomUUID(),
        title,
        created_by: author,
        created_at: new Date().toISOString(),
        origin_session_id: originSessionId,
    });
}
export function newMessage({ topicId, author, body, originSessionId, replyTo }) {
    return compact({
        id: randomUUID(),
        topic_id: topicId,
        author,
        body,
        created_at: new Date().toISOString(),
        origin_session_id: originSessionId,
        reply_to: replyTo,
    });
}
// Events are { type, data } with data holding the canonical record.
const EVENT_FIELDS = {
    topic_created: { id: true, title: true, created_by: true, created_at: true, origin_session_id: false },
    message_posted: {
        id: true,
        topic_id: true,
        author: true,
        body: true,
        created_at: true,
        origin_session_id: false,
        reply_to: false,
    },
};
const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEventType = (type) => typeof type === 'string' && Object.hasOwn(EVENT_FIELDS, type);
// Builds the canonical { type, data } from a flattened { type, ...fields } value; throws with a
// reason if it is malformed or of an unknown type.
export function canonicalEvent(event) {
    if (!isJsonObject(event)) {
        throw new Error('record is not a JSON object');
    }
    // Non-string types would otherwise coerce to a key, e.g. ["topic_created"].
    if (!isEventType(event.type)) {
        throw new Error(`unknown record type ${JSON.stringify(event.type)}`);
    }
    // Fields of the type's record by name; typed so that it can be asserted to be that record.
    const data = {};
    for (const [name, required] of Object.entries(EVENT_FIELDS[event.type])) {
        const value = event[name];
        if (value === undefined && !required)
            continue;
        if (typeof value !== 'string' || value === '')
            throw new Error(`invalid ${event.type} field ${name}`);
        data[name] = value;
    }
    // data holds a non-empty string for each required field of the type's record and only its fields.
    return { type: event.type, data };
}
