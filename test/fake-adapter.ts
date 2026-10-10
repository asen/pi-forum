import { randomUUID } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import { ForumError } from '../src/forum.mjs'
import type { EventVisitor, ForumAdapter, ForumEvent, ForumStore, OpenOptions } from '../src/types.d.mts'

// One in-memory forum: its events in append order, and the tail of its queue of writes.
export interface FakeForum {
  events: ForumEvent[]
  writing: Promise<unknown>
}

// The adapter, with the controls tests use: its forums by directory, and a predicate that decides
// which appends fail.
export interface FakeAdapter extends ForumAdapter {
  readonly forums: Map<string, FakeForum>
  failAppends(predicate: (event: ForumEvent) => boolean): void
}

interface FakeCursor {
  forum: FakeForum
  index: number
}

// In-memory adapter. Its cursors are random tokens, so the facade cannot decode them. Reads yield
// between records and stop once their signal is aborted.
export function fakeAdapter(): FakeAdapter {
  const forums = new Map<string, FakeForum>()
  const cursors = new Map<string, FakeCursor>()
  let failAppend: (event: ForumEvent) => boolean = () => false
  return {
    forums,
    failAppends(predicate) {
      failAppend = predicate
    },
    async open({ forumDir, create }: OpenOptions): Promise<ForumStore> {
      let created = forums.get(forumDir)
      if (!created) {
        if (!create) throw new ForumError('FORUM_UNAVAILABLE', `forum ${forumDir} does not exist`)
        created = { events: [], writing: Promise.resolve() }
        forums.set(forumDir, created)
      }
      const forum = created
      const scan = async (start: number, visit: EventVisitor, signal?: AbortSignal) => {
        let index = start
        while (index < forum.events.length) {
          await tick()
          if (signal?.aborted) throw new ForumError('ABORTED', 'fake read aborted', { cause: signal.reason })
          // In range: the loop condition was checked before the yield, and events are only appended.
          if (visit(structuredClone(forum.events[index++]!))) break
        }
        return index
      }
      return {
        identity: forumDir,
        async read({ after, signal }, visit) {
          let start = 0
          if (after !== undefined) {
            const cursor = cursors.get(after)
            if (cursor?.forum !== forum) throw new ForumError('INVALID_CURSOR', 'cursor is not valid')
            start = cursor.index
          }
          const token = `fake-${randomUUID()}`
          cursors.set(token, { forum, index: await scan(start, visit, signal) })
          return token
        },
        write(options, fn) {
          const run = forum.writing.then(() =>
            fn({
              read: async (visit) => {
                await scan(0, visit)
              },
              append: async (event) => {
                if (failAppend(event)) {
                  throw new ForumError('WRITE_FAILED', 'fake append failed', { cause: new Error('injected') })
                }
                forum.events.push(structuredClone(event))
              },
            }),
          )
          forum.writing = run.catch(() => {})
          return run
        },
      }
    },
  }
}
