// Consumer contract of jsonl.mjs: the adapter that keeps each forum in an append-only events.jsonl
// log in its directory.
import type { ForumAdapter } from '../types.d.mts'

export declare const jsonlAdapter: ForumAdapter
