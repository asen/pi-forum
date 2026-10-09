import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { promisify } from 'node:util'
import { encodeCursor } from '../src/cursor.js'
import { createTopic, getTopic, listMessages, listTopics, postMessage } from '../src/storage.js'

const roots = []

after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempForum() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-test-'))
  roots.push(root)
  return path.join(root, 'forum')
}

const logPath = (dir) => path.join(dir, 'events.jsonl')
const lockPath = (dir) => path.join(dir, '.write-lock')

async function readEvents(dir) {
  const text = await fs.readFile(logPath(dir), 'utf8')
  assert.ok(text.endsWith('\n'))
  return text.slice(0, -1).split('\n').map((line) => JSON.parse(line))
}

async function readAll(fn, dir, options) {
  const items = []
  let cursor
  for (;;) {
    const page = await fn(dir, { ...options, after: cursor })
    items.push(...page.items)
    assert.equal(typeof page.next_cursor, 'string')
    if (page.items.length === 0) return { items, cursor: page.next_cursor }
    cursor = page.next_cursor
  }
}

function collectWarnings() {
  const warnings = []
  return { warnings, onWarning: (message) => warnings.push(message) }
}

const forumError = (code) => (err) => err.name === 'ForumError' && err.code === code

async function assertUnchanged(dir, fn) {
  const before = await fs.readFile(logPath(dir))
  await fn()
  assert.deepEqual(await fs.readFile(logPath(dir)), before)
  await assert.rejects(fs.stat(lockPath(dir)), { code: 'ENOENT' })
}

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('writing', () => {
  test('creates the forum directory and a topic without a body', async () => {
    const dir = await tempForum()
    const { topic, message } = await createTopic(dir, { title: 'Flaky tests', author: 'alice' })
    assert.equal(message, null)
    assert.deepEqual(Object.keys(topic), ['id', 'title', 'created_by', 'created_at'])
    assert.match(topic.id, UUID)
    assert.match(topic.created_at, ISO)
    assert.equal(topic.title, 'Flaky tests')
    assert.equal(topic.created_by, 'alice')
    assert.deepEqual(await readEvents(dir), [{ type: 'topic_created', ...topic }])
    assert.deepEqual((await fs.readdir(dir)).sort(), ['events.jsonl'])
  })

  test('creates a topic with an initial message and origin session', async () => {
    const dir = await tempForum()
    const body = '  Report findings here.\n\n  Keep indentation.  '
    const { topic, message } = await createTopic(dir, {
      title: 'Investigate',
      author: 'sess-1',
      body,
      originSessionId: 'sess-1',
    })
    assert.equal(topic.origin_session_id, 'sess-1')
    assert.deepEqual(Object.keys(message), ['id', 'topic_id', 'author', 'body', 'created_at', 'origin_session_id'])
    assert.equal(message.topic_id, topic.id)
    assert.equal(message.body, body)
    assert.deepEqual(await readEvents(dir), [
      { type: 'topic_created', ...topic },
      { type: 'message_posted', ...message },
    ])
    assert.deepEqual(await getTopic(dir, topic.id), topic)
  })

  test('posts messages and same-topic replies', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const first = await postMessage(dir, { topicId: topic.id, author: 'a', body: 'first' })
    assert.equal(first.reply_to, undefined)
    assert.equal(first.origin_session_id, undefined)
    const reply = await postMessage(dir, {
      topicId: topic.id,
      author: 'b',
      body: 'reply',
      replyTo: first.id,
      originSessionId: 'sess-b',
    })
    assert.equal(reply.reply_to, first.id)
    assert.equal(reply.origin_session_id, 'sess-b')
    const { items } = await listMessages(dir, { topicId: topic.id })
    assert.deepEqual(items, [first, reply])
  })

  test('invalid references append nothing', async () => {
    const dir = await tempForum()
    const { topic, message } = await createTopic(dir, { title: 'A', author: 'a', body: 'in A' })
    const { topic: other } = await createTopic(dir, { title: 'B', author: 'a' })
    await assertUnchanged(dir, async () => {
      await assert.rejects(postMessage(dir, { topicId: 'missing', author: 'a', body: 'x' }), forumError('NOT_FOUND'))
      await assert.rejects(
        postMessage(dir, { topicId: topic.id, author: 'a', body: 'x', replyTo: 'missing' }),
        forumError('NOT_FOUND'),
      )
      await assert.rejects(
        postMessage(dir, { topicId: other.id, author: 'a', body: 'x', replyTo: message.id }),
        forumError('INVALID_INPUT'),
      )
      // A topic ID is not a message ID.
      await assert.rejects(
        postMessage(dir, { topicId: topic.id, author: 'a', body: 'x', replyTo: topic.id }),
        forumError('NOT_FOUND'),
      )
    })
  })

  test('posting to a topic in an empty forum fails without creating a log', async () => {
    const dir = await tempForum()
    await assert.rejects(postMessage(dir, { topicId: 'x', author: 'a', body: 'b' }), forumError('NOT_FOUND'))
    await assert.rejects(fs.stat(logPath(dir)), { code: 'ENOENT' })
    await assert.rejects(fs.stat(lockPath(dir)), { code: 'ENOENT' })
  })

  test('rejects invalid input without appending', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const invalid = forumError('INVALID_INPUT')
    await assertUnchanged(dir, async () => {
      for (const input of [
        {},
        { title: '', author: 'a' },
        { title: ' \n\t', author: 'a' },
        { title: 'T', author: '  ' },
        { title: 'T', author: 'a', body: '   ' },
        { title: 'T', author: 'a', body: 42 },
        { title: 42, author: 'a' },
        { title: 'x'.repeat(257), author: 'a' },
        { title: 'T', author: 'é'.repeat(257) },
        { title: 'T', author: 'a', originSessionId: ' ' },
        { title: 'T\uD800', author: 'a' },
      ]) {
        await assert.rejects(createTopic(dir, input), invalid, JSON.stringify(input))
      }
      for (const input of [
        { topicId: topic.id, author: 'a', body: '' },
        { topicId: topic.id, author: 'a' },
        { topicId: topic.id, author: '', body: 'b' },
        { topicId: '', author: 'a', body: 'b' },
        { topicId: topic.id, author: 'a', body: 'b', replyTo: '' },
        // 21846 three-byte characters are 65538 bytes but fewer than 65536 characters.
        { topicId: topic.id, author: 'a', body: '€'.repeat(21846) },
      ]) {
        await assert.rejects(postMessage(dir, input), invalid, JSON.stringify(input).slice(0, 80))
      }
      await assert.rejects(createTopic('relative/forum', { title: 'T', author: 'a' }), invalid)
      await assert.rejects(listTopics('relative/forum'), invalid)
    })
  })

  test('accepts limits at their bounds', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: '🧵'.repeat(256), author: 'é'.repeat(256) })
    const body = `${'x'.repeat(64 * 1024 - 4)}🧵`
    const message = await postMessage(dir, { topicId: topic.id, author: 'a', body })
    assert.equal(Buffer.byteLength(message.body), 64 * 1024)
    assert.deepEqual((await listMessages(dir)).items, [message])
    assert.deepEqual(await getTopic(dir, topic.id), topic)
  })
})

describe('reading', () => {
  test('an empty forum lists nothing and its cursor stays valid', async () => {
    const dir = await tempForum()
    const topics = await listTopics(dir)
    assert.deepEqual(topics.items, [])
    const messages = await listMessages(dir, { after: topics.next_cursor })
    assert.deepEqual(messages.items, [])
    assert.equal(messages.next_cursor, topics.next_cursor)
    await assert.rejects(getTopic(dir, 'missing'), forumError('NOT_FOUND'))
    // The directory was created, but reads create no files.
    assert.deepEqual(await fs.readdir(dir), [])
  })

  test('getTopic reports a clear not-found error', async () => {
    const dir = await tempForum()
    await createTopic(dir, { title: 'T', author: 'a' })
    await assert.rejects(getTopic(dir, 'nope'), { code: 'NOT_FOUND', message: 'topic nope not found' })
  })

  test('default and explicit limits', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    for (let i = 1; i < 25; i++) await createTopic(dir, { title: `T${i}`, author: 'a' })
    for (let i = 0; i < 60; i++) await postMessage(dir, { topicId: topic.id, author: 'a', body: `m${i}` })
    assert.equal((await listTopics(dir)).items.length, 20)
    assert.equal((await listMessages(dir)).items.length, 50)
    assert.equal((await listTopics(dir, { limit: 1 })).items.length, 1)
    assert.equal((await listMessages(dir, { limit: 100 })).items.length, 60)
    for (const limit of [0, 101, 1.5, '5', -1, Number.NaN]) {
      await assert.rejects(listTopics(dir, { limit }), forumError('INVALID_INPUT'), String(limit))
    }
  })

  test('paginates and filters multibyte records in append order', async () => {
    const dir = await tempForum()
    const titles = ['Ünïcödé', '日本語のトピック', '🧪 tests', 'plain', 'Ελληνικά']
    const topics = []
    for (const title of titles) topics.push((await createTopic(dir, { title, author: 'ä', body: `${title} 🚀` })).topic)
    const messages = []
    for (let i = 0; i < 12; i++) {
      const topic = topics[i % topics.length]
      messages.push(await postMessage(dir, { topicId: topic.id, author: 'β', body: `${i}: こんにちは 👋\n✓` }))
    }

    const allTopics = await readAll(listTopics, dir, { limit: 2 })
    assert.deepEqual(allTopics.items, topics)

    const allMessages = await readAll(listMessages, dir, { limit: 3 })
    assert.equal(allMessages.items.length, topics.length + messages.length)
    assert.deepEqual(allMessages.items.slice(topics.length), messages)

    const target = topics[2]
    const filtered = await readAll(listMessages, dir, { topicId: target.id, limit: 1 })
    assert.deepEqual(
      filtered.items,
      allMessages.items.filter((message) => message.topic_id === target.id),
    )
    assert.equal(filtered.items.length, 3)

    // Cursors at the end pick up later appends, including from a filtered read.
    const later = await postMessage(dir, { topicId: target.id, author: 'γ', body: 'später ✨' })
    const newTopic = (await createTopic(dir, { title: 'новая', author: 'δ' })).topic
    assert.deepEqual((await listMessages(dir, { after: filtered.cursor, topicId: target.id })).items, [later])
    assert.deepEqual((await listMessages(dir, { after: allMessages.cursor })).items, [later])
    assert.deepEqual((await listTopics(dir, { after: allTopics.cursor })).items, [newTopic])
  })

  test('next_cursor advances over filtered records', async () => {
    const dir = await tempForum()
    const { topic: a } = await createTopic(dir, { title: 'A', author: 'a' })
    const { topic: b } = await createTopic(dir, { title: 'B', author: 'a' })
    for (let i = 0; i < 5; i++) await postMessage(dir, { topicId: b.id, author: 'a', body: `b${i}` })
    const first = await listMessages(dir, { topicId: a.id })
    assert.deepEqual(first.items, [])
    assert.equal(decode(first.next_cursor).offset, (await fs.stat(logPath(dir))).size)
    const message = await postMessage(dir, { topicId: a.id, author: 'a', body: 'a0' })
    assert.deepEqual((await listMessages(dir, { topicId: a.id, after: first.next_cursor })).items, [message])
  })
})

function decode(cursor) {
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
}

// Re-encodes a cursor with another offset, keeping its forum identity.
function encodeCursorFor(cursor, offset) {
  return encodeCursor(decode(cursor).forum, offset)
}

describe('cursors', () => {
  test('have the documented opaque shape', async () => {
    const dir = await tempForum()
    await createTopic(dir, { title: 'T', author: 'a' })
    const { next_cursor } = await listTopics(dir)
    assert.match(next_cursor, /^[A-Za-z0-9_-]+$/)
    const value = decode(next_cursor)
    assert.deepEqual(Object.keys(value), ['v', 'forum', 'offset'])
    assert.equal(value.v, 1)
    assert.match(value.forum, /^[0-9a-f]{64}$/)
    assert.equal(value.offset, (await fs.stat(logPath(dir))).size)
  })

  test('identify a forum by its real directory', async () => {
    const dir = await tempForum()
    await createTopic(dir, { title: 'T', author: 'a' })
    const link = path.join(path.dirname(dir), 'link')
    await fs.symlink(dir, link)
    const { next_cursor } = await listTopics(dir, { limit: 1 })
    assert.deepEqual(await listTopics(link, { after: next_cursor }), { items: [], next_cursor })
  })

  test('from another forum are rejected', async () => {
    const a = await tempForum()
    const b = await tempForum()
    await createTopic(a, { title: 'A', author: 'a' })
    await createTopic(b, { title: 'B', author: 'a' })
    const { next_cursor } = await listTopics(a, { limit: 1 })
    await assert.rejects(listTopics(b, { after: next_cursor }), {
      code: 'INVALID_CURSOR',
      message: 'cursor belongs to a different forum',
    })
  })

  test('that are malformed or out of bounds are rejected', async () => {
    const dir = await tempForum()
    await createTopic(dir, { title: 'Ünï', author: 'a', body: '日本語' })
    const { next_cursor } = await listTopics(dir, { limit: 1 })
    const { forum, offset } = decode(next_cursor)
    const bytes = await fs.readFile(logPath(dir))
    const size = bytes.length
    const raw = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const bad = [
      '',
      'not a cursor!',
      'abc',
      raw(null),
      raw([1]),
      raw({ v: 2, forum, offset }),
      raw({ forum, offset }),
      raw({ v: 1, offset }),
      raw({ v: 1, forum, offset: -1 }),
      raw({ v: 1, forum, offset: 1.5 }),
      raw({ v: 1, forum, offset: '0' }),
      raw({ v: 1, forum, offset: Number.MAX_SAFE_INTEGER + 1 }),
      raw({ v: 1, forum, offset: size + 1 }),
      raw({ v: 1, forum, offset: offset - 1 }),
      raw({ v: 1, forum, offset: offset + 1 }),
      // Inside a multibyte character of the second record.
      raw({ v: 1, forum, offset: bytes.indexOf('日本語') + 1 }),
    ]
    for (const after of bad) {
      await assert.rejects(listMessages(dir, { after }), forumError('INVALID_CURSOR'), after)
    }
    for (const after of [encodeCursor(forum, 0), encodeCursor(forum, offset), encodeCursor(forum, size)]) {
      await listMessages(dir, { after })
    }
  })
})

describe('damaged logs', () => {
  test('malformed and unknown complete records are skipped with warnings', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const offset = (await fs.stat(logPath(dir))).size
    const junk = [
      Buffer.from('not json\n'),
      Buffer.from('\n'),
      Buffer.from('[1,2]\n'),
      Buffer.from('{"type":"topic_deleted","id":"x"}\n'),
      Buffer.from('{"type":"message_posted","id":"m","topic_id":"t"}\n'),
      Buffer.from('{"type":"topic_created","id":"x","title":7,"created_by":"a","created_at":"z"}\n'),
      Buffer.concat([Buffer.from('{"type":"topic_created","id":"bad","title":"'), Buffer.from([0xff, 0xfe]), Buffer.from('","created_by":"a","created_at":"z"}\n')]),
    ]
    await fs.appendFile(logPath(dir), Buffer.concat(junk))
    const offsets = []
    let position = offset
    for (const line of junk) {
      offsets.push(position)
      position += line.length
    }

    const message = await postMessage(dir, { topicId: topic.id, author: 'a', body: 'still works' }, { onWarning() {} })

    const { warnings, onWarning } = collectWarnings()
    const all = await listMessages(dir, { onWarning })
    assert.deepEqual(all.items, [message])
    assert.equal(warnings.length, junk.length)
    warnings.forEach((warning, i) => assert.match(warning, new RegExp(`malformed record at byte offset ${offsets[i]}:`)))
    assert.match(warnings[3], /unknown record type "topic_deleted"/)

    const topics = await listTopics(dir, { onWarning() {} })
    assert.deepEqual(topics.items, [topic])
    assert.equal(decode(topics.next_cursor).offset, (await fs.stat(logPath(dir))).size)

    // A page that ends after skipped records resumes beyond them without repeating warnings.
    const page = collectWarnings()
    const first = await listTopics(dir, { limit: 1, onWarning: page.onWarning })
    assert.deepEqual(page.warnings, [])
    assert.equal(decode(first.next_cursor).offset, offset)
    const rest = collectWarnings()
    const second = await listMessages(dir, { after: first.next_cursor, limit: 1, onWarning: rest.onWarning })
    assert.deepEqual(second.items, [message])
    assert.equal(rest.warnings.length, junk.length)
    assert.deepEqual(await getTopic(dir, topic.id, { onWarning() {} }), topic)
  })

  test('records with a non-string type are skipped with warnings', async () => {
    const dir = await tempForum()
    const { topic, message } = await createTopic(dir, { title: 'T', author: 'a', body: 'ok' })
    const offset = (await fs.stat(logPath(dir))).size
    const fields = '"id":"coerced","title":"X","created_by":"a","created_at":"z"'
    const messageFields = `"id":"m2","topic_id":"${topic.id}","author":"a","body":"b","created_at":"z"`
    const junk = [
      `{"type":["topic_created"],${fields}}\n`,
      `{"type":{"toString":"topic_created"},${fields}}\n`,
      `{"type":1,${fields}}\n`,
      `{${fields}}\n`,
      `{"type":["message_posted"],${messageFields}}\n`,
    ]
    await fs.appendFile(logPath(dir), junk.join(''))
    const after = await postMessage(dir, { topicId: topic.id, author: 'a', body: 'after' }, { onWarning() {} })

    const expected = []
    let position = offset
    for (const line of junk) {
      expected.push(new RegExp(`^skipping malformed record at byte offset ${position}: unknown record type`))
      position += Buffer.byteLength(line)
    }
    const topics = collectWarnings()
    assert.deepEqual((await listTopics(dir, { onWarning: topics.onWarning })).items, [topic])
    assert.equal(topics.warnings.length, junk.length)
    topics.warnings.forEach((warning, i) => assert.match(warning, expected[i]))
    assert.match(topics.warnings[0], /unknown record type \["topic_created"\]/)

    const messages = collectWarnings()
    assert.deepEqual((await listMessages(dir, { onWarning: messages.onWarning })).items, [message, after])
    assert.equal(messages.warnings.length, junk.length)
    await assert.rejects(getTopic(dir, 'coerced', { onWarning() {} }), forumError('NOT_FOUND'))
    await assert.rejects(
      postMessage(dir, { topicId: topic.id, author: 'a', body: 'x', replyTo: 'm2' }, { onWarning() {} }),
      forumError('NOT_FOUND'),
    )
  })

  test('an incomplete tail is ignored by reads and refused by writes', async () => {
    const dir = await tempForum()
    const { topic, message } = await createTopic(dir, { title: 'T', author: 'a', body: 'ok' })
    const complete = (await fs.stat(logPath(dir))).size
    await fs.appendFile(logPath(dir), '{"type":"message_posted","id":"half","body":"日本')

    const { warnings, onWarning } = collectWarnings()
    const page = await listMessages(dir, { onWarning })
    assert.deepEqual(page.items, [message])
    assert.deepEqual(warnings, [`ignoring incomplete record at byte offset ${complete}`])
    assert.equal(decode(page.next_cursor).offset, complete)
    assert.deepEqual((await listMessages(dir, { after: page.next_cursor, onWarning() {} })).items, [])
    assert.deepEqual(await getTopic(dir, topic.id, { onWarning() {} }), topic)
    // A cursor cannot point past the incomplete tail.
    const end = (await fs.stat(logPath(dir))).size
    await assert.rejects(
      listMessages(dir, { after: encodeCursorFor(page.next_cursor, end), onWarning() {} }),
      forumError('INVALID_CURSOR'),
    )

    await assertUnchanged(dir, async () => {
      await assert.rejects(createTopic(dir, { title: 'T2', author: 'a' }), {
        code: 'INCOMPLETE_LOG',
        message: new RegExp(`incomplete record at byte offset ${complete}; repair it manually`),
      })
      await assert.rejects(
        postMessage(dir, { topicId: topic.id, author: 'a', body: 'x' }, { onWarning() {} }),
        forumError('INCOMPLETE_LOG'),
      )
    })
  })
})

describe('locking', () => {
  test('concurrent in-process writes keep distinct complete records', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const posted = await Promise.all(
      Array.from({ length: 40 }, (_, i) => postMessage(dir, { topicId: topic.id, author: 'a', body: `${i} ✓` })),
    )
    const events = await readEvents(dir)
    assert.equal(events.length, 41)
    assert.equal(new Set(events.map((event) => event.id)).size, 41)
    assert.deepEqual(new Set((await listMessages(dir, { limit: 100 })).items.map((m) => m.id)), new Set(posted.map((m) => m.id)))
  })

  test('concurrent processes keep distinct complete records', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const storage = new URL('../src/storage.js', import.meta.url).href
    const script = `
      import { createTopic, postMessage } from ${JSON.stringify(storage)}
      const [dir, topicId, worker] = process.argv.slice(1)
      for (let i = 0; i < 10; i++) {
        await postMessage(dir, { topicId, author: worker, body: worker + ':' + i + ' ' + '🧵'.repeat(500) })
        if (i % 5 === 0) await createTopic(dir, { title: worker + ':' + i, author: worker, body: 'é'.repeat(1000) })
      }
    `
    const run = promisify(execFile)
    await Promise.all(
      Array.from({ length: 4 }, (_, worker) =>
        run(process.execPath, ['--input-type=module', '-e', script, dir, topic.id, `w${worker}`]),
      ),
    )
    const events = await readEvents(dir)
    // 1 topic + 4 workers x (10 messages + 2 topics with initial messages).
    assert.equal(events.length, 1 + 4 * 14)
    assert.equal(new Set(events.map((event) => event.id)).size, events.length)
    const bodies = (await readAll(listMessages, dir, { topicId: topic.id, limit: 100 })).items.map((m) => m.body)
    for (let worker = 0; worker < 4; worker++) {
      const own = bodies.filter((body) => body.startsWith(`w${worker}:`)).map((body) => body.split(' ')[0])
      assert.deepEqual(own, Array.from({ length: 10 }, (_, i) => `w${worker}:${i}`))
    }
    await assert.rejects(fs.stat(lockPath(dir)), { code: 'ENOENT' })
  })

  test('a stale lock fails within a bounded time and is left in place', async () => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const before = await fs.readFile(logPath(dir))
    await fs.mkdir(lockPath(dir))
    const started = Date.now()
    await assert.rejects(postMessage(dir, { topicId: topic.id, author: 'a', body: 'x' }), {
      code: 'LOCK_TIMEOUT',
      message: /remove it manually/,
    })
    const elapsed = Date.now() - started
    assert.ok(elapsed >= 1900 && elapsed < 4000, `elapsed ${elapsed}ms`)
    assert.ok((await fs.stat(lockPath(dir))).isDirectory())
    assert.deepEqual(await fs.readFile(logPath(dir)), before)
    // Reads do not need the lock.
    assert.deepEqual((await listTopics(dir)).items, [topic])
  })

  test('a failed append is reported and releases the lock', async (t) => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const failure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    t.mock.method(fs, 'appendFile', async () => {
      throw failure
    })
    await assertUnchanged(dir, async () => {
      await assert.rejects(postMessage(dir, { topicId: topic.id, author: 'a', body: 'x' }), (err) => {
        assert.equal(err.code, 'WRITE_FAILED')
        assert.equal(err.cause, failure)
        assert.match(err.message, /ENOSPC/)
        return true
      })
      await assert.rejects(createTopic(dir, { title: 'T2', author: 'a' }), forumError('WRITE_FAILED'))
    })
    t.mock.restoreAll()
    await postMessage(dir, { topicId: topic.id, author: 'a', body: 'after' })
  })

  test('a failed initial message reports the created topic and releases the lock', async (t) => {
    const dir = await tempForum()
    const appendFile = fs.appendFile
    const failure = new Error('EIO: i/o error')
    t.mock.method(fs, 'appendFile', async (...args) => {
      if (String(args[1]).includes('"message_posted"')) throw failure
      return appendFile(...args)
    })
    let created
    await assert.rejects(createTopic(dir, { title: 'Partial', author: 'a', body: 'lost' }), (err) => {
      assert.equal(err.code, 'PARTIAL_WRITE')
      assert.equal(err.cause.code, 'WRITE_FAILED')
      assert.equal(err.cause.cause, failure)
      assert.match(err.message, new RegExp(`topic ${err.topic.id} was created`))
      created = err.topic
      return true
    })
    t.mock.restoreAll()
    await assert.rejects(fs.stat(lockPath(dir)), { code: 'ENOENT' })
    assert.deepEqual(await getTopic(dir, created.id), created)
    assert.deepEqual((await listMessages(dir)).items, [])
    await postMessage(dir, { topicId: created.id, author: 'a', body: 'retry' })
  })

  test('a lock release failure after a failed initial message keeps the partial write error', async (t) => {
    const dir = await tempForum()
    const appendFile = fs.appendFile
    const failure = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    const lockFailure = Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    t.mock.method(fs, 'appendFile', async (...args) => {
      if (String(args[1]).includes('"message_posted"')) throw failure
      return appendFile(...args)
    })
    t.mock.method(fs, 'rmdir', async () => {
      throw lockFailure
    })
    const warn = t.mock.method(console, 'warn', () => {})
    let created
    await assert.rejects(createTopic(dir, { title: 'Partial', author: 'a', body: 'lost' }), (err) => {
      assert.equal(err.name, 'ForumError')
      assert.equal(err.code, 'PARTIAL_WRITE')
      assert.equal(err.cause.code, 'WRITE_FAILED')
      assert.equal(err.cause.cause, failure)
      assert.match(err.message, new RegExp(`topic ${err.topic.id} was created`))
      created = err.topic
      return true
    })
    t.mock.restoreAll()
    assert.equal(warn.mock.callCount(), 1)
    assert.equal(
      warn.mock.calls[0].arguments[0],
      `pi-forum: warning: could not remove ${lockPath(dir)} after a failed write: ${lockFailure.message}; ` +
        'if no pi-forum write is running, remove it manually',
    )
    // The lock is left for manual cleanup, and the created topic is readable.
    assert.ok((await fs.stat(lockPath(dir))).isDirectory())
    await fs.rmdir(lockPath(dir))
    assert.deepEqual(await getTopic(dir, created.id), created)
  })

  test('a lock release failure after a failed append keeps the write error', async (t) => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const before = await fs.readFile(logPath(dir))
    const failure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    t.mock.method(fs, 'appendFile', async () => {
      throw failure
    })
    t.mock.method(fs, 'rmdir', async () => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    })
    const { warnings, onWarning } = collectWarnings()
    await assert.rejects(postMessage(dir, { topicId: topic.id, author: 'a', body: 'x' }, { onWarning }), (err) => {
      assert.equal(err.name, 'ForumError')
      assert.equal(err.code, 'WRITE_FAILED')
      assert.equal(err.cause, failure)
      return true
    })
    t.mock.restoreAll()
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^could not remove .*\.write-lock after a failed write: EROFS: read-only file system;/)
    assert.deepEqual(await fs.readFile(logPath(dir)), before)
    assert.ok((await fs.stat(lockPath(dir))).isDirectory())
    await fs.rmdir(lockPath(dir))
  })

  test('a lock release failure without a value is still warned about', async (t) => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const failure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    t.mock.method(fs, 'appendFile', async () => {
      throw failure
    })
    t.mock.method(fs, 'rmdir', async () => {
      throw null
    })
    const { warnings, onWarning } = collectWarnings()
    await assert.rejects(postMessage(dir, { topicId: topic.id, author: 'a', body: 'x' }, { onWarning }), (err) => {
      assert.equal(err.code, 'WRITE_FAILED')
      assert.equal(err.cause, failure)
      return true
    })
    t.mock.restoreAll()
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /^could not remove .*\.write-lock after a failed write: undefined;/)
    await fs.rmdir(lockPath(dir))
  })

  test('a throwing warning callback does not replace a failed append error', async (t) => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const before = await fs.readFile(logPath(dir))
    const failure = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    const reporterFailure = new Error('reporter failed')
    t.mock.method(fs, 'appendFile', async () => {
      throw failure
    })
    t.mock.method(fs, 'rmdir', async () => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    })
    const onWarning = t.mock.fn(() => {
      throw reporterFailure
    })
    await assert.rejects(postMessage(dir, { topicId: topic.id, author: 'a', body: 'x' }, { onWarning }), (err) => {
      assert.notEqual(err, reporterFailure)
      assert.equal(err.name, 'ForumError')
      assert.equal(err.code, 'WRITE_FAILED')
      assert.equal(err.cause, failure)
      return true
    })
    t.mock.restoreAll()
    assert.equal(onWarning.mock.callCount(), 1)
    assert.match(onWarning.mock.calls[0].arguments[0], /^could not remove .*\.write-lock after a failed write: EROFS/)
    assert.deepEqual(await fs.readFile(logPath(dir)), before)
    assert.ok((await fs.stat(lockPath(dir))).isDirectory())
    await fs.rmdir(lockPath(dir))
  })

  test('a throwing default warning does not replace a partial write error', async (t) => {
    const dir = await tempForum()
    const appendFile = fs.appendFile
    const failure = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    const reporterFailure = new Error('stderr closed')
    t.mock.method(fs, 'appendFile', async (...args) => {
      if (String(args[1]).includes('"message_posted"')) throw failure
      return appendFile(...args)
    })
    t.mock.method(fs, 'rmdir', async () => {
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    })
    const warn = t.mock.method(console, 'warn', () => {
      throw reporterFailure
    })
    let created
    await assert.rejects(createTopic(dir, { title: 'Partial', author: 'a', body: 'lost' }), (err) => {
      assert.notEqual(err, reporterFailure)
      assert.equal(err.name, 'ForumError')
      assert.equal(err.code, 'PARTIAL_WRITE')
      assert.equal(err.cause.code, 'WRITE_FAILED')
      assert.equal(err.cause.cause, failure)
      assert.match(err.message, new RegExp(`topic ${err.topic.id} was created`))
      created = err.topic
      return true
    })
    t.mock.restoreAll()
    assert.equal(warn.mock.callCount(), 1)
    assert.ok((await fs.stat(lockPath(dir))).isDirectory())
    await fs.rmdir(lockPath(dir))
    assert.deepEqual(await getTopic(dir, created.id), created)
    assert.deepEqual((await listMessages(dir)).items, [])
  })

  test('a lock release failure after a successful write is still reported as a failure', async (t) => {
    const dir = await tempForum()
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    const lockFailure = Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    t.mock.method(fs, 'rmdir', async () => {
      throw lockFailure
    })
    const { warnings, onWarning } = collectWarnings()
    await assert.rejects(postMessage(dir, { topicId: topic.id, author: 'a', body: 'kept' }, { onWarning }), lockFailure)
    t.mock.restoreAll()
    assert.deepEqual(warnings, [])
    // The append itself completed before the release failed.
    assert.deepEqual((await listMessages(dir)).items.map((m) => m.body), ['kept'])
    await fs.rmdir(lockPath(dir))
  })
})
