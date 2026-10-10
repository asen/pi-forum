// Consumer contract of cli.mjs: one CLI invocation, run by bin/pi-forum, and what it reads and writes.
import type { CreateForumOptions, Forum } from './types.d.mts'

// The environment main reads: PI_FORUM_DIR and PI_SESSION_ID.
export type Environment = { readonly [name: string]: string | undefined }

// Where main writes its output and warnings; the process streams by default.
export interface OutputWriter {
  write(chunk: string): void
}

// Binds the forum client of one invocation; createForum by default.
export type ForumFactory = (options: CreateForumOptions) => Forum

export interface MainOptions {
  createForum?: ForumFactory | undefined
  stdout?: OutputWriter | undefined
  stderr?: OutputWriter | undefined
}

// Runs one CLI invocation and returns its exit status.
export declare function main(argv: readonly string[], env?: Environment, options?: MainOptions): Promise<number>
