// Consumer contract of forum.mjs: the shared forum API, bound to one forum directory by createForum.
// The adapter contract and the API's inputs and results are typed in types.d.mts.
import type { CreateForumOptions, Forum } from './types.d.mts'

export { ForumError } from './records.mjs'

export declare function createForum(options: CreateForumOptions): Forum
