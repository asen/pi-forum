import { ForumError, createForum } from './forum.js'
import type {
  CreateTopicInput,
  CreateTopicResult,
  ListMessagesOptions,
  ListOptions,
  Message,
  Page,
  PostMessageInput,
  ReadCallOptions,
  Topic,
  WriteCallOptions,
} from './types.js'

export { ForumError }

// Compatibility wrappers over the shared forum API with the JSONL adapter. Reads create the forum
// directory, as they always have.
const bind = (forumDir: string) => createForum({ forumDir, createOnRead: true })

export async function listTopics(forumDir: string, options?: ListOptions): Promise<Page<Topic>> {
  return bind(forumDir).listTopics(options)
}

export async function listMessages(forumDir: string, options?: ListMessagesOptions): Promise<Page<Message>> {
  return bind(forumDir).listMessages(options)
}

export async function getTopic(forumDir: string, topicId: string, options?: ReadCallOptions): Promise<Topic> {
  return bind(forumDir).getTopic(topicId, options)
}

export async function createTopic(forumDir: string, input: CreateTopicInput): Promise<CreateTopicResult> {
  return bind(forumDir).createTopic(input)
}

export async function postMessage(forumDir: string, input: PostMessageInput, options?: WriteCallOptions): Promise<Message> {
  return bind(forumDir).postMessage(input, options)
}
