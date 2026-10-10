// Consumer contract of storage.mjs: compatibility wrappers over the shared forum API with the JSONL
// adapter.
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
} from './types.d.mts'

export { ForumError } from './forum.mjs'

export declare function listTopics(forumDir: string, options?: ListOptions): Promise<Page<Topic>>
export declare function listMessages(forumDir: string, options?: ListMessagesOptions): Promise<Page<Message>>
export declare function getTopic(forumDir: string, topicId: string, options?: ReadCallOptions): Promise<Topic>
export declare function createTopic(forumDir: string, input: CreateTopicInput): Promise<CreateTopicResult>
export declare function postMessage(
  forumDir: string,
  input: PostMessageInput,
  options?: WriteCallOptions,
): Promise<Message>
