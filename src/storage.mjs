import { ForumError, createForum } from './forum.mjs'

/**
 * @import {
 *   CreateTopicInput,
 *   CreateTopicResult,
 *   ListMessagesOptions,
 *   ListOptions,
 *   Message,
 *   Page,
 *   PostMessageInput,
 *   ReadCallOptions,
 *   Topic,
 *   WriteCallOptions,
 * } from './types.d.mts'
 */

export { ForumError }

// Compatibility wrappers over the shared forum API with the JSONL adapter. Reads create the forum
// directory, as they always have.
/** @param {string} forumDir */
const bind = (forumDir) => createForum({ forumDir, createOnRead: true })

/**
 * @param {string} forumDir
 * @param {ListOptions} [options]
 * @returns {Promise<Page<Topic>>}
 */
export async function listTopics(forumDir, options) {
  return bind(forumDir).listTopics(options)
}

/**
 * @param {string} forumDir
 * @param {ListMessagesOptions} [options]
 * @returns {Promise<Page<Message>>}
 */
export async function listMessages(forumDir, options) {
  return bind(forumDir).listMessages(options)
}

/**
 * @param {string} forumDir
 * @param {string} topicId
 * @param {ReadCallOptions} [options]
 * @returns {Promise<Topic>}
 */
export async function getTopic(forumDir, topicId, options) {
  return bind(forumDir).getTopic(topicId, options)
}

/**
 * @param {string} forumDir
 * @param {CreateTopicInput} input
 * @returns {Promise<CreateTopicResult>}
 */
export async function createTopic(forumDir, input) {
  return bind(forumDir).createTopic(input)
}

/**
 * @param {string} forumDir
 * @param {PostMessageInput} input
 * @param {WriteCallOptions} [options]
 * @returns {Promise<Message>}
 */
export async function postMessage(forumDir, input, options) {
  return bind(forumDir).postMessage(input, options)
}
