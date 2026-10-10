import assert from 'node:assert/strict'
import { readSync } from 'node:fs'
import type { PathLike } from 'node:fs'
import fs from 'node:fs/promises'
import type { FileHandle, FileReadResult } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import type { CursorData } from '../src/cursor.mjs'
import { ForumError, createForum } from '../src/forum.mjs'
import { listTopics } from '../src/storage.mjs'
import type { Message, Page, SearchHit, Topic } from '../src/types.d.mts'

const roots: string[] = []

after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-jsonl-read-test-'))
  roots.push(root)
  return root
}

const quiet = { onWarning() {} }
const PRIVILEGED = process.getuid?.() === 0

// A rejection as the predicates that use this view read it. Thrown values are unknown; reading their
// fields through this type is the only unchecked step, and the predicates assert each field they use.
interface Rejection extends Error {
  code: string
  cause: Rejection
  topic: Topic
}
const rejection = (check: (err: Rejection) => boolean) => (thrown: unknown) => check(thrown as Rejection)

// Denies access by clearing file's mode, or, since root ignores modes, by failing fs[method] for
// target. Returns a function that restores access.
async function deny(t: TestContext, file: string, method: 'open' | 'realpath', target: string) {
  if (PRIVILEGED) {
    // Either method, taking the path and passing its other arguments through untouched.
    const original: (path: PathLike, ...args: never[]) => Promise<unknown> = fs[method]
    const mock = t.mock.method(fs, method, async (path: PathLike, ...args: never[]) => {
      if (path === target) throw Object.assign(new Error(`EACCES: permission denied, ${method} '${path}'`), { code: 'EACCES' })
      return original(path, ...args)
    })
    return () => mock.mock.restore()
  }
  const { mode } = await fs.stat(file)
  await fs.chmod(file, 0o000)
  return () => fs.chmod(file, mode)
}

const decode = (cursor: string): CursorData => JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))

// Every entry below root without following links: a directory's mode, a link's target, or a
// file's mode, mtime and bytes (when readable).
async function snapshot(root: string, prefix = ''): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  for (const name of (await fs.readdir(path.join(root, prefix))).sort()) {
    const entry = path.join(prefix, name)
    const file = path.join(root, entry)
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) entries[entry] = `-> ${await fs.readlink(file)}`
    else if (stat.isDirectory()) Object.assign(entries, { [entry]: `dir ${stat.mode}` }, await snapshot(root, entry))
    else {
      const bytes = await fs.readFile(file).then((data) => data.toString('base64'), (err: NodeJS.ErrnoException) => err.code)
      entries[entry] = `file ${stat.mode} ${stat.mtimeMs} ${bytes}`
    }
  }
  return entries
}

// Runs every read of a default client and asserts that each reports FORUM_UNAVAILABLE for
// forumDir with the given underlying cause, leaving the files and the environment unchanged.
async function assertUnavailable(root: string, forumDir: string, causeCode: string) {
  const before = await snapshot(root)
  const env = { ...process.env }
  const forum = createForum({ forumDir })
  const reads = [
    () => forum.listTopics(quiet),
    () => forum.listMessages({ ...quiet, topicId: 't' }),
    () => forum.getTopic('t', quiet),
    () => forum.getMessage('m', quiet),
    () => forum.search('NOT t', quiet),
  ]
  for (const read of reads) {
    await assert.rejects(
      read(),
      rejection((err) => {
        assert.ok(err instanceof ForumError)
        assert.equal(err.code, 'FORUM_UNAVAILABLE')
        assert.ok(err.message.includes(forumDir), err.message)
        assert.equal(err.cause?.code, causeCode)
        return true
      }),
    )
  }
  assert.equal(forum.resolved, undefined)
  assert.deepEqual(await snapshot(root), before)
  assert.deepEqual({ ...process.env }, env)
}

describe('noncreating reads', () => {
  test('a missing directory is unavailable and is not created', async () => {
    const root = await tempRoot()
    await assertUnavailable(root, path.join(root, 'missing'), 'ENOENT')
    await assertUnavailable(root, path.join(root, 'missing', 'nested'), 'ENOENT')
    assert.deepEqual(await fs.readdir(root), [])
  })

  test('a file, or a path through a file, is unavailable', async () => {
    const root = await tempRoot()
    const file = path.join(root, 'file')
    await fs.writeFile(file, 'not a forum\n')
    await assertUnavailable(root, file, 'ENOTDIR')
    await assertUnavailable(root, path.join(file, 'forum'), 'ENOTDIR')
    assert.equal(await fs.readFile(file, 'utf8'), 'not a forum\n')
  })

  test('a dangling symlink is unavailable and its target is not created', async () => {
    const root = await tempRoot()
    const link = path.join(root, 'link')
    await fs.symlink(path.join(root, 'target'), link)
    await assertUnavailable(root, link, 'ENOENT')
    await assert.rejects(fs.lstat(path.join(root, 'target')), { code: 'ENOENT' })
  })

  test('a log that is not a file is unavailable', async () => {
    const root = await tempRoot()
    const forumDir = path.join(root, 'forum')
    await fs.mkdir(path.join(forumDir, 'events.jsonl'), { recursive: true })
    await assertUnavailable(root, forumDir, 'EISDIR')
  })

  test('inaccessible storage is unavailable rather than empty', async (t) => {
    const root = await tempRoot()
    const forumDir = path.join(root, 'forum')
    await createForum({ forumDir }).createTopic({ title: 'T', author: 'a' })
    const log = path.join(forumDir, 'events.jsonl')
    let restore = await deny(t, log, 'open', log)
    try {
      await assertUnavailable(root, forumDir, 'EACCES')
    } finally {
      await restore()
    }

    // An unsearchable parent fails while resolving the directory.
    const forum = createForum({ forumDir })
    restore = await deny(t, root, 'realpath', forumDir)
    try {
      await assert.rejects(
        forum.listTopics(),
        rejection((err) => {
          assert.equal(err.code, 'FORUM_UNAVAILABLE')
          assert.ok(err.message.includes(forumDir), err.message)
          assert.equal(err.cause.code, 'EACCES')
          return true
        }),
      )
    } finally {
      await restore()
    }
    assert.equal(forum.resolved, undefined)
    assert.equal((await forum.listTopics()).items.length, 1)
  })

  test('an existing directory without a log is an empty forum and stays untouched', async () => {
    const root = await tempRoot()
    const forumDir = path.join(root, 'forum')
    await fs.mkdir(forumDir)
    const env = { ...process.env }
    const forum = createForum({ forumDir })
    const topics = await forum.listTopics()
    assert.deepEqual(topics.items, [])
    assert.equal(decode(topics.next_cursor).offset, 0)
    const messages = await forum.listMessages({ topicId: 'none' })
    assert.equal(messages.next_cursor, topics.next_cursor)
    await assert.rejects(forum.getTopic('t'), { code: 'NOT_FOUND' })
    await assert.rejects(forum.getMessage('m'), { code: 'NOT_FOUND' })
    const hits = await forum.search('NOT t')
    assert.deepEqual(hits, { items: [], next_cursor: topics.next_cursor })
    assert.deepEqual(await fs.readdir(forumDir), [])
    assert.deepEqual({ ...process.env }, env)

    // The empty forum's cursor reads later writes, across lists and filters.
    const { topic, message } = await forum.createTopic({ title: 'T', author: 'a', body: 'b' })
    assert.deepEqual((await forum.listTopics({ after: topics.next_cursor })).items, [topic])
    assert.deepEqual((await forum.listMessages({ after: topics.next_cursor })).items, [message])
    assert.deepEqual((await forum.listMessages({ after: messages.next_cursor, topicId: topic.id })).items, [message])
    assert.deepEqual((await forum.search('b', { after: hits.next_cursor })).items, [{ type: 'message', message }])
  })

  test('reads of a populated forum change no bytes and take no lock', async () => {
    const root = await tempRoot()
    const forumDir = path.join(root, 'forum')
    const writer = createForum({ forumDir })
    const { topic, message } = await writer.createTopic({ title: 'T', author: 'a', body: 'b' })
    const before = await snapshot(root)
    const forum = createForum({ forumDir })
    const page = await forum.listTopics({ limit: 1 })
    await forum.listMessages({ after: page.next_cursor, topicId: topic.id })
    await forum.getTopic(topic.id)
    // createTopic returns a message whenever it is given a body.
    await forum.getMessage(message!.id)
    await assert.rejects(forum.getMessage('missing'), { code: 'NOT_FOUND' })
    assert.equal((await forum.search('T OR b', { after: page.next_cursor })).items.length, 1)
    assert.deepEqual(await snapshot(root), before)
  })

  test('an invalid search query touches no storage, even when reads create', async (t) => {
    const root = await tempRoot()
    const forumDir = path.join(root, 'forum')
    const realpath = t.mock.method(fs, 'realpath')
    const mkdir = t.mock.method(fs, 'mkdir')
    const trace = traceReads(t)
    const forum = createForum({ forumDir, createOnRead: true })
    for (const query of ['', 'a AND', '"open', 'a\uD800', 'x'.repeat(4097)]) {
      await assert.rejects(forum.search(query), { code: 'INVALID_INPUT' }, query.slice(0, 20))
    }
    assert.equal(realpath.mock.callCount(), 0)
    assert.equal(mkdir.mock.callCount(), 0)
    assert.equal(trace.handles.length, 0)
    assert.deepEqual(await fs.readdir(root), [])
    assert.equal(forum.resolved, undefined)
  })

  test('createOnRead and writes keep creating missing directories', async () => {
    const root = await tempRoot()
    const read = path.join(root, 'read', 'forum')
    assert.deepEqual((await createForum({ forumDir: read, createOnRead: true }).listTopics()).items, [])
    assert.deepEqual(await fs.readdir(read), [])
    const searched = path.join(root, 'searched', 'forum')
    assert.deepEqual((await createForum({ forumDir: searched, createOnRead: true }).search('T')).items, [])
    assert.deepEqual(await fs.readdir(searched), [])
    assert.deepEqual((await listTopics(path.join(root, 'wrapper'))).items, [])
    assert.deepEqual(await fs.readdir(path.join(root, 'wrapper')), [])

    const written = path.join(root, 'written')
    await assert.rejects(
      createForum({ forumDir: written }).postMessage({ topicId: 't', author: 'a', body: 'b' }),
      { code: 'NOT_FOUND' },
    )
    assert.deepEqual(await fs.readdir(written), [])
  })
})

describe('forum identity', () => {
  async function linkedForum() {
    const root = await tempRoot()
    const a = path.join(root, 'a')
    const b = path.join(root, 'b')
    const link = path.join(root, 'link')
    await createForum({ forumDir: a }).createTopic({ title: 'in A', author: 'a', body: 'A' })
    await createForum({ forumDir: b }).createTopic({ title: 'in B', author: 'b', body: 'B' })
    await fs.symlink(a, link)
    return { root, a, b, link }
  }

  async function retarget(link: string, target: string) {
    const next = `${link}.next`
    await fs.symlink(target, next)
    await fs.rename(next, link)
  }

  test('symlink aliases share cursors with the real directory', async () => {
    const { a, link } = await linkedForum()
    const real = createForum({ forumDir: a })
    const alias = createForum({ forumDir: link })
    const page = await real.listTopics()
    assert.deepEqual(await alias.listTopics(), page)
    assert.equal(alias.resolved, await fs.realpath(a))
    assert.equal(alias.forumDir, link)

    const first = await alias.listMessages({ limit: 1 })
    const added = await real.postMessage({ topicId: page.items[0]!.id, author: 'a', body: 'more' })
    assert.deepEqual((await real.listMessages({ after: first.next_cursor })).items, [added])
    assert.deepEqual((await alias.listTopics({ after: page.next_cursor })).items, [])
    assert.deepEqual((await alias.listMessages({ after: page.next_cursor, topicId: page.items[0]!.id })).items, [added])
    assert.deepEqual((await alias.search('more OR A', { after: page.next_cursor })).items, [{ type: 'message', message: added }])
  })

  test('a client keeps its first forum when its symlink is retargeted', async () => {
    const { root, a, b, link } = await linkedForum()
    const forum = createForum({ forumDir: link })
    assert.equal(forum.resolved, undefined)
    const page = await forum.listTopics()
    assert.equal(forum.resolved, await fs.realpath(a))
    const before = await snapshot(root)

    await retarget(link, b)
    const moved = rejection((err) => {
      assert.equal(err.code, 'FORUM_UNAVAILABLE')
      assert.ok(err.message.includes(link), err.message)
      return true
    })
    await assert.rejects(forum.listTopics(), moved)
    await assert.rejects(forum.listMessages({ after: page.next_cursor }), moved)
    await assert.rejects(forum.getTopic(page.items[0]!.id), moved)
    await assert.rejects(forum.getMessage('m'), moved)
    await assert.rejects(forum.search('in', { after: page.next_cursor }), moved)
    await assert.rejects(forum.createTopic({ title: 'T', author: 'a' }), moved)
    await assert.rejects(forum.postMessage({ topicId: page.items[0]!.id, author: 'a', body: 'x' }), moved)
    assert.equal(forum.resolved, await fs.realpath(a))
    assert.deepEqual(await snapshot(root), { ...before, link: `-> ${b}` })

    // Retargeting to a missing directory is unavailable too, and creates nothing.
    await retarget(link, path.join(root, 'gone'))
    await assert.rejects(forum.listTopics(), moved)
    await assert.rejects(forum.search('in'), moved)
    await assert.rejects(fs.lstat(path.join(root, 'gone')), { code: 'ENOENT' })

    // Pointing back at the pinned forum works again.
    await retarget(link, a)
    assert.deepEqual((await forum.listTopics()).items, page.items)
    assert.deepEqual((await forum.search('"in A"')).items, [{ type: 'topic', topic: page.items[0] }])

    // A new client explicitly selects the new target; the old forum's cursor does not carry over.
    await retarget(link, b)
    const reselected = createForum({ forumDir: link })
    const other = await reselected.listTopics()
    assert.deepEqual(other.items.map((topic) => topic.title), ['in B'])
    assert.equal(reselected.resolved, await fs.realpath(b))
    await assert.rejects(reselected.listTopics({ after: page.next_cursor }), { code: 'INVALID_CURSOR' })
    await assert.rejects(reselected.search('in', { after: page.next_cursor }), { code: 'INVALID_CURSOR' })
  })
})

// The adapter reads in 64 KiB chunks and holds records of at most 1 MiB.
const CHUNK = 64 * 1024
const MAX_RECORD = 1024 * 1024
const CREATED = '2026-01-01T00:00:00.000Z'

const topicLine = (id: string, title = 'T') =>
  `${JSON.stringify({ type: 'topic_created', id, title, created_by: 'a', created_at: CREATED })}\n`
const messageLine = (id: string, topicId: string, body: string) =>
  `${JSON.stringify({ type: 'message_posted', id, topic_id: topicId, author: 'a', body, created_at: CREATED })}\n`
const message = (id: string, topicId: string, body: string): Message => ({ id, topic_id: topicId, author: 'a', body, created_at: CREATED })
const topic = (id: string, title = 'T'): Topic => ({ id, title, created_by: 'a', created_at: CREATED })
const messageHit = (id: string, topicId: string, body: string): SearchHit => ({ type: 'message', message: message(id, topicId, body) })

// A forum directory whose log holds exactly the given lines.
async function logForum(lines: (string | Buffer)[]) {
  const forumDir = path.join(await tempRoot(), 'forum')
  await fs.mkdir(forumDir)
  const log = path.join(forumDir, 'events.jsonl')
  await fs.writeFile(log, Buffer.concat(lines.map((line) => Buffer.from(line))))
  return { forumDir, log }
}

// A log of topic t followed by messages of about 1 KiB, at least size bytes long.
async function largeForum(size: number) {
  const lines = [topicLine('t')]
  for (let i = 0, total = 0; total < size; i++) {
    const line = messageLine(`m${i}`, 't', `${i} ${'x'.repeat(1000)}`)
    lines.push(line)
    total += Buffer.byteLength(line)
  }
  return { ...(await logForum(lines)), count: lines.length - 1 }
}

// The one form of FileHandle.read the adapter uses: a read into its buffer at an explicit position.
// The mocks below replace read with only this form, so they assign it through a cast.
type PositionalRead = (buffer: Buffer, offset: number, length: number, position: number) => Promise<FileReadResult<Buffer>>

interface ReadTrace {
  handles: FileHandle[]
  reads: { position: number; length: number }[]
  closed(): boolean
}

// Records each descriptor opened through fs.open and each positional read on it. onRead runs
// before the read with the read's position, length and 1-based count.
function traceReads(t: TestContext, onRead?: (read: { position: number; length: number; count: number }) => unknown) {
  const trace: ReadTrace = {
    handles: [],
    reads: [],
    closed: () => trace.handles.every((handle) => handle.fd === -1),
  }
  const open = fs.open
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args)
    trace.handles.push(handle)
    const read = handle.read.bind(handle)
    const traced: PositionalRead = async (buffer, offset, length, position) => {
      trace.reads.push({ position, length })
      await onRead?.({ position, length, count: trace.reads.length })
      return read(buffer, offset, length, position)
    }
    handle.read = traced as FileHandle['read']
    return handle
  })
  return trace
}

function collectWarnings() {
  const warnings: string[] = []
  return { warnings, onWarning: (warning: string) => warnings.push(warning) }
}

const aborted = (err: unknown) => err instanceof ForumError && err.code === 'ABORTED'

describe('chunked scanning', () => {
  test('a cursor page reads from its offset, not the earlier log', async (t) => {
    const { forumDir, count } = await largeForum(6 * CHUNK)
    const forum = createForum({ forumDir })
    let first: Pick<Page<Message>, 'items'> & { next_cursor?: string } = { items: [] }
    for (let read = 0; read < count - 2; read += first.items.length) {
      first = await forum.listMessages({ limit: Math.min(100, count - 2 - read), after: first.next_cursor })
    }
    // The loop ran, so the last page read has a cursor.
    const offset = decode(first.next_cursor!).offset
    assert.ok(offset > 5 * CHUNK)
    const trace = traceReads(t)
    const rest = await forum.listMessages({ after: first.next_cursor })
    assert.deepEqual(rest.items.map((m) => m.id), [`m${count - 2}`, `m${count - 1}`])
    // Only the one-byte boundary check looks before the cursor.
    assert.deepEqual(trace.reads.filter((read) => read.position < offset), [{ position: offset - 1, length: 1 }])
    assert.ok(trace.reads.every((read) => read.length <= CHUNK))
    assert.ok(trace.closed())
  })

  test('characters and records split across chunks decode intact', async () => {
    const head = topicLine('t')
    const prefix = Buffer.byteLength(head) + Buffer.byteLength(messageLine('m', 't', '').split('"body":"')[0]!) + 8
    for (let shift = 1; shift <= 4; shift++) {
      // The 4-byte character starts shift bytes before the chunk boundary.
      const body = `${'x'.repeat(CHUNK - shift - prefix)}🧵日本`
      const { forumDir } = await logForum([head, messageLine('m', 't', body), messageLine('n', 't', 'after')])
      const forum = createForum({ forumDir })
      const { items } = await forum.listMessages()
      assert.deepEqual(items, [message('m', 't', body), message('n', 't', 'after')], `shift ${shift}`)
      // The split character matches as text, and only in its own record.
      assert.deepEqual((await forum.search('x🧵日本')).items, [messageHit('m', 't', body)], `shift ${shift}`)
      assert.deepEqual((await forum.search('"日本" OR after')).items, [messageHit('m', 't', body), messageHit('n', 't', 'after')])
      assert.deepEqual((await forum.search('🧵 AND after')).items, [])
    }

    // A record that ends exactly at the chunk boundary, and one whose newline starts the next chunk.
    for (const end of [CHUNK, CHUNK + 1]) {
      const fill = end - Buffer.byteLength(head) - Buffer.byteLength(messageLine('m', 't', ''))
      const record = messageLine('m', 't', 'é'.repeat(fill / 2) + 'x'.repeat(fill % 2))
      const lines = [head, record, messageLine('n', 't', 'é')]
      assert.equal(Buffer.byteLength(head + record), end)
      const { forumDir } = await logForum(lines)
      const forum = createForum({ forumDir })
      const page = await forum.listMessages({ limit: 1 })
      assert.equal(decode(page.next_cursor).offset, end)
      assert.deepEqual((await forum.listMessages({ after: page.next_cursor })).items, [message('n', 't', 'é')])
      const hit = await forum.search('é', { limit: 1 })
      assert.equal(decode(hit.next_cursor).offset, end)
      assert.deepEqual((await forum.search('é', { after: hit.next_cursor })).items, [messageHit('n', 't', 'é')])
    }
  })

  test('a search matches decoded text, not its JSON escapes', async () => {
    const title = 'Café "quoted"\ttab'
    const body = 'line\nbreak \\path\\ é'
    // The first two lines escape as JSON.stringify does; the last spells its characters as \u escapes.
    const { forumDir } = await logForum([
      topicLine('t', title),
      messageLine('m', 't', body),
      `{"type":"topic_created","id":"u","title":"Caf\\u00e9 \\u0022unicode\\u0022","created_by":"a","created_at":"${CREATED}"}\n`,
    ])
    const forum = createForum({ forumDir })
    const search = async (query: string) => (await forum.search(query)).items
    const unicode: SearchHit = { type: 'topic', topic: topic('u', 'Café "unicode"') }
    assert.deepEqual(await search('café'), [{ type: 'topic', topic: topic('t', title) }, unicode])
    assert.deepEqual(await search('"\\"quoted\\""'), [{ type: 'topic', topic: topic('t', title) }])
    assert.deepEqual(await search('"\\"unicode\\""'), [unicode])
    assert.deepEqual(await search('"quoted\\"\ttab"'), [{ type: 'topic', topic: topic('t', title) }])
    assert.deepEqual(await search('"line\nbreak"'), [messageHit('m', 't', body)])
    assert.deepEqual(await search('"\\\\path\\\\"'), [messageHit('m', 't', body)])
    // The escapes themselves are not text.
    for (const query of ['u00e9', 'u0022', '"\\\\t"', '"\\\\n"', '"\\\\\\\\"', '"\\\\\\""']) {
      assert.deepEqual(await search(query), [], query)
    }
  })

  test('an incomplete tail is ignored until a later read finds it complete', async () => {
    const line = messageLine('m', 't', `${'日本'.repeat(CHUNK / 3)} tail`)
    const head = topicLine('t')
    const split = Buffer.byteLength(line) - 7
    const { forumDir, log } = await logForum([head, Buffer.from(line).subarray(0, split)])
    const forum = createForum({ forumDir })
    const first = collectWarnings()
    const page = await forum.listMessages({ onWarning: first.onWarning })
    assert.deepEqual(page.items, [])
    assert.deepEqual(first.warnings, [`ignoring incomplete record at byte offset ${Buffer.byteLength(head)}`])
    assert.equal(decode(page.next_cursor).offset, Buffer.byteLength(head))

    await fs.appendFile(log, Buffer.from(line).subarray(split))
    const later = collectWarnings()
    const next = await forum.listMessages({ after: page.next_cursor, onWarning: later.onWarning })
    const { body }: { body: string } = JSON.parse(line)
    assert.deepEqual(next.items, [message('m', 't', body)])
    assert.deepEqual(later.warnings, [])
  })

  test('a search ignores an incomplete tail, and its cursor finds it once complete', async () => {
    const line = messageLine('m', 't', `${'日本'.repeat(CHUNK / 3)} needle tail`)
    const head = topicLine('t', 'needle head')
    const split = Buffer.byteLength(line) - 7
    const { forumDir, log } = await logForum([head, Buffer.from(line).subarray(0, split)])
    const forum = createForum({ forumDir })
    const first = collectWarnings()
    const page = await forum.search('needle', { onWarning: first.onWarning })
    assert.deepEqual(page.items, [{ type: 'topic', topic: topic('t', 'needle head') }])
    assert.deepEqual(first.warnings, [`ignoring incomplete record at byte offset ${Buffer.byteLength(head)}`])
    assert.equal(decode(page.next_cursor).offset, Buffer.byteLength(head))

    await fs.appendFile(log, Buffer.from(line).subarray(split))
    const later = collectWarnings()
    const next = await forum.search('"needle tail"', { after: page.next_cursor, onWarning: later.onWarning })
    const { body }: { body: string } = JSON.parse(line)
    assert.deepEqual(next.items, [messageHit('m', 't', body)])
    assert.deepEqual(later.warnings, [])
  })

  test('oversized and malformed records are skipped, and an oversized tail is incomplete', async () => {
    const head = topicLine('t')
    const empty = Buffer.byteLength(messageLine('big', 't', '')) - 1
    const fits = messageLine('fit', 't', 'x'.repeat(MAX_RECORD - empty))
    const big = messageLine('big', 't', 'x'.repeat(MAX_RECORD - empty + 1))
    assert.equal(Buffer.byteLength(fits), MAX_RECORD + 1)
    const lines = [head, fits, big, 'not json\n', messageLine('ok', 't', 'ok'), `{"type":"${'y'.repeat(2 * MAX_RECORD)}`]
    const offsets: number[] = []
    let offset = 0
    for (const line of lines) {
      offsets.push(offset)
      offset += Buffer.byteLength(line)
    }
    const { forumDir } = await logForum(lines)
    const forum = createForum({ forumDir })

    const { warnings, onWarning } = collectWarnings()
    const page = await forum.listMessages({ onWarning })
    assert.deepEqual(page.items.map((m) => m.id), ['fit', 'ok'])
    assert.equal(warnings.length, 3)
    assert.equal(
      warnings[0],
      `skipping malformed record at byte offset ${offsets[2]}: record is larger than ${MAX_RECORD} bytes`,
    )
    assert.match(warnings[1]!, new RegExp(`^skipping malformed record at byte offset ${offsets[3]}: `))
    assert.equal(warnings[2], `ignoring incomplete record at byte offset ${offsets[5]}`)
    assert.equal(decode(page.next_cursor).offset, offsets[5])
    // The skipped record does not stop paging: the next page resumes at its following boundary.
    const first = await forum.listMessages({ limit: 1, ...quiet })
    const second = await forum.listMessages({ limit: 1, after: first.next_cursor, ...quiet })
    assert.deepEqual(second.items.map((m) => m.id), ['ok'])

    // A search skips the same records with the same warnings, matches only the valid ones, and its
    // cursor moves past the skipped records whether or not their text would match.
    const searched = collectWarnings()
    const hits = await forum.search('NOT json', { onWarning: searched.onWarning })
    assert.deepEqual(hits.items, [
      { type: 'topic', topic: topic('t') },
      messageHit('fit', 't', 'x'.repeat(MAX_RECORD - empty)),
      messageHit('ok', 't', 'ok'),
    ])
    assert.deepEqual(searched.warnings, warnings)
    assert.equal(hits.next_cursor, page.next_cursor)
    assert.deepEqual((await forum.search('json OR yyy OR big', quiet)).items, [])
    const fit = await forum.search('x', { limit: 1, ...quiet })
    assert.deepEqual(fit.items.map((hit) => hit.type === 'message' && hit.message.id), ['fit'])
    assert.equal(decode(fit.next_cursor).offset, offsets[2])
    const rest = collectWarnings()
    const ok = await forum.search('ok', { after: fit.next_cursor, onWarning: rest.onWarning })
    assert.deepEqual(ok.items, [messageHit('ok', 't', 'ok')])
    assert.deepEqual(rest.warnings, warnings)
    const after = await forum.search('ok', { after: ok.next_cursor, ...quiet })
    assert.deepEqual(after, { items: [], next_cursor: page.next_cursor })

    await assert.rejects(forum.postMessage({ topicId: 't', author: 'a', body: 'x' }, quiet), {
      code: 'INCOMPLETE_LOG',
      message: new RegExp(`incomplete record at byte offset ${offsets[5]}; repair it manually`),
    })
  })

  test('a read excludes bytes appended after it opened the log', async (t) => {
    const { forumDir, log, count } = await largeForum(3 * CHUNK)
    const size = (await fs.stat(log)).size
    const forum = createForum({ forumDir })
    const { next_cursor } = await forum.listTopics({ limit: 1 })
    traceReads(t, async ({ count: reads }) => {
      if (reads === 2) await fs.appendFile(log, messageLine('late', 't', 'late'))
    })
    // No later topic exists, so the read scans its whole snapshot.
    const page = await forum.listTopics({ after: next_cursor })
    t.mock.restoreAll()
    assert.deepEqual(page.items, [])
    assert.equal(decode(page.next_cursor).offset, size)
    assert.ok(count > 100)
    const later = await forum.listMessages({ after: page.next_cursor })
    assert.deepEqual(later.items.map((m) => m.id), ['late'])
  })

  test('a search excludes bytes appended after it opened the log, and resumes before them', async (t) => {
    const { forumDir, log } = await largeForum(3 * CHUNK)
    const size = (await fs.stat(log)).size
    const forum = createForum({ forumDir })
    const { next_cursor } = await forum.search('t', { limit: 1 })
    traceReads(t, async ({ count: reads }) => {
      if (reads === 2) await fs.appendFile(log, messageLine('late', 't', 'late needle'))
    })
    const page = await forum.search('needle', { after: next_cursor })
    t.mock.restoreAll()
    assert.deepEqual(page.items, [])
    assert.equal(decode(page.next_cursor).offset, size)
    // A later search with any query takes a fresh snapshot from the empty page's cursor.
    assert.deepEqual((await forum.search('late', { after: page.next_cursor })).items, [messageHit('late', 't', 'late needle')])
    assert.deepEqual((await forum.search('needle', { after: page.next_cursor })).items, [messageHit('late', 't', 'late needle')])
  })

  test('a log truncated during a read is reported, not listed', async (t) => {
    const { forumDir, log } = await largeForum(4 * CHUNK)
    const trace = traceReads(t, async ({ count }) => {
      if (count === 2) await fs.truncate(log, CHUNK + 10)
    })
    await assert.rejects(
      createForum({ forumDir }).listMessages({ limit: 100, topicId: 'none' }),
      rejection((err) => {
        assert.equal(err.code, 'FORUM_UNAVAILABLE')
        assert.ok(err.message.includes(forumDir))
        assert.match(err.cause.message, /ended at byte \d+ while reading its first \d+ bytes; it was truncated/)
        return true
      }),
    )
    assert.ok(trace.closed())

    // Historical creating reads report the same failure without wrapping it.
    const { forumDir: other, log: otherLog } = await largeForum(4 * CHUNK)
    t.mock.restoreAll()
    traceReads(t, async ({ count }) => {
      if (count === 2) await fs.truncate(otherLog, CHUNK + 10)
    })
    await assert.rejects(createForum({ forumDir: other, createOnRead: true }).getMessage('missing'), /truncated/)
  })

  test('a log truncated during a search is reported, not listed', async (t) => {
    const { forumDir, log } = await largeForum(4 * CHUNK)
    const trace = traceReads(t, async ({ count }) => {
      if (count === 2) await fs.truncate(log, CHUNK + 10)
    })
    const forum = createForum({ forumDir })
    await assert.rejects(
      forum.search('absent', { limit: 100 }),
      rejection((err) => {
        assert.equal(err.code, 'FORUM_UNAVAILABLE')
        assert.ok(err.message.includes(forumDir))
        assert.match(err.cause.message, /ended at byte \d+ while reading its first \d+ bytes; it was truncated/)
        return true
      }),
    )
    assert.ok(trace.closed())
    assert.equal(forum.resolved, undefined)
  })

  test('a full page or a found record stops reading', async (t) => {
    const { forumDir } = await largeForum(16 * CHUNK)
    const forum = createForum({ forumDir })
    const trace = traceReads(t)
    assert.equal((await forum.listMessages({ limit: 3 })).items.length, 3)
    assert.equal((await forum.getTopic('t')).id, 't')
    assert.equal((await forum.getMessage('m5')).id, 'm5')
    assert.equal((await forum.search('x', { limit: 3 })).items.length, 3)
    assert.equal(trace.reads.length, 4)
    assert.ok(trace.closed())
  })

  test('cancellation before or during a long filtered scan reports ABORTED and closes the log', async (t) => {
    const { forumDir } = await largeForum(32 * CHUNK)
    const forum = createForum({ forumDir })
    const before = new AbortController()
    before.abort()
    let trace = traceReads(t)
    await assert.rejects(forum.listMessages({ topicId: 'none', signal: before.signal }), aborted)
    await assert.rejects(forum.search('none', { signal: before.signal }), aborted)
    assert.equal(trace.handles.length, 0)
    t.mock.restoreAll()

    for (const read of [
      (signal: AbortSignal) => forum.listMessages({ topicId: 'none', limit: 100, signal }),
      (signal: AbortSignal) => forum.getMessage('missing', { signal }),
      (signal: AbortSignal) => forum.getTopic('missing', { signal }),
      (signal: AbortSignal) => forum.search('none', { limit: 100, signal }),
      (signal: AbortSignal) => forum.search('NOT x', { limit: 100, signal }),
    ]) {
      const controller = new AbortController()
      trace = traceReads(t, ({ count }) => {
        if (count === 3) controller.abort()
      })
      await assert.rejects(read(controller.signal), aborted)
      assert.equal(trace.reads.length, 3)
      assert.ok(trace.closed())
      t.mock.restoreAll()
    }
  })

  test('a long scan lets timers and other callbacks run', async (t) => {
    const { forumDir } = await largeForum(64 * CHUNK)
    // Reads that settle without returning to the event loop, as cached reads could: only the
    // scanner's own yields let the heartbeat run.
    const open = fs.open
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const cached: PositionalRead = async (buffer, offset, length, position) => ({
        bytesRead: readSync(handle.fd, buffer, offset, length, position),
        buffer,
      })
      handle.read = cached as FileHandle['read']
      return handle
    })
    let ticks = 0
    let running = true
    const heartbeat = () => {
      ticks++
      if (running) setImmediate(heartbeat)
    }
    setImmediate(heartbeat)
    let timerFired = false
    setTimeout(() => {
      timerFired = true
    }, 0)
    await assert.rejects(createForum({ forumDir }).getMessage('missing'), { code: 'NOT_FOUND' })
    running = false
    assert.ok(timerFired)
    // At least one heartbeat per 64 KiB chunk.
    assert.ok(ticks >= 64, `heartbeat ran ${ticks} times`)
  })

  test('reads do not wait for the writer lock', async () => {
    const { forumDir } = await largeForum(2 * CHUNK)
    await fs.mkdir(path.join(forumDir, '.write-lock'))
    const started = Date.now()
    const forum = createForum({ forumDir })
    assert.equal((await forum.listTopics()).items.length, 1)
    assert.equal((await forum.getMessage('m3')).id, 'm3')
    assert.ok(Date.now() - started < 1000)
    assert.ok((await fs.stat(path.join(forumDir, '.write-lock'))).isDirectory())
  })

  test('writes validate references with bounded reads', async (t) => {
    const { forumDir, count } = await largeForum(8 * CHUNK)
    const forum = createForum({ forumDir })
    const trace = traceReads(t)
    const reply = await forum.postMessage({ topicId: 't', author: 'a', body: 'r', replyTo: `m${count - 1}` })
    assert.equal(reply.reply_to, `m${count - 1}`)
    assert.ok(trace.reads.every((read) => read.length <= CHUNK))
    assert.ok(trace.closed())
    t.mock.restoreAll()
    assert.deepEqual(await forum.getMessage(reply.id), reply)
  })
})
