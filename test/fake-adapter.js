import { randomUUID } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import { ForumError } from '../src/forum.js'

// In-memory adapter. Its cursors are random tokens, so the facade cannot decode them. Reads yield
// between records and stop once their signal is aborted.
export function fakeAdapter() {
  const forums = new Map()
  const cursors = new Map()
  let failAppend = () => false
  return {
    forums,
    failAppends(predicate) {
      failAppend = predicate
    },
    async open({ forumDir, create }) {
      if (!forums.has(forumDir)) {
        if (!create) throw new ForumError('FORUM_UNAVAILABLE', `forum ${forumDir} does not exist`)
        forums.set(forumDir, { events: [], writing: Promise.resolve() })
      }
      const forum = forums.get(forumDir)
      const scan = async (start, visit, signal) => {
        let index = start
        while (index < forum.events.length) {
          await tick()
          if (signal?.aborted) throw new ForumError('ABORTED', 'fake read aborted', { cause: signal.reason })
          if (visit(structuredClone(forum.events[index++]))) break
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
