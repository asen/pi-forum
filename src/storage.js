import { ForumError, createForum } from './forum.js';
export { ForumError };
// Compatibility wrappers over the shared forum API with the JSONL adapter. Reads create the forum
// directory, as they always have.
const bind = (forumDir) => createForum({ forumDir, createOnRead: true });
export async function listTopics(forumDir, options) {
    return bind(forumDir).listTopics(options);
}
export async function listMessages(forumDir, options) {
    return bind(forumDir).listMessages(options);
}
export async function getTopic(forumDir, topicId, options) {
    return bind(forumDir).getTopic(topicId, options);
}
export async function createTopic(forumDir, input) {
    return bind(forumDir).createTopic(input);
}
export async function postMessage(forumDir, input, options) {
    return bind(forumDir).postMessage(input, options);
}
