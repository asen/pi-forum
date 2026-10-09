import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { jsonlAdapter } from '../src/backends/jsonl.js'
import { ForumError, createForum } from '../src/forum.js'
import { fakeAdapter } from './fake-adapter.js'

const roots = []

after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const forumError = (code) => (err) => err instanceof ForumError && err.code === code
const quiet = { onWarning() {} }

const jsonlSetup = {
  adapter: jsonlAdapter,
  async forumDir() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-forum-test-'))
    roots.push(root)
    return path.join(root, 'forum')
  },
  exists: (forumDir) => fs.stat(forumDir).then(() => true, () => false),
  failAppends(t, type) {
    const appendFile = fs.appendFile
    t.mock.method(fs, 'appendFile', async (...args) => {
      if (JSON.parse(String(args[1])).type === type) throw new Error('EIO: injected')
      return appendFile(...args)
    })
  },
}

function fakeSetup() {
  const adapter = fakeAdapter()
  return {
    adapter,
    forumDir: async () => `/fake/${randomUUID()}`,
    exists: async (forumDir) => adapter.forums.has(forumDir),
    failAppends(t, type) {
      adapter.failAppends((event) => event.type === type)
      t.after(() => adapter.failAppends(() => false))
    },
  }
}

async function readAll(fn, options) {
  const items = []
  let cursor
  for (;;) {
    const page = await fn({ ...options, after: cursor })
    assert.equal(typeof page.next_cursor, 'string')
    items.push(...page.items)
    if (page.items.length === 0) return { items, cursor: page.next_cursor }
    cursor = page.next_cursor
  }
}

// The public contract every adapter must satisfy through createForum.
function contract(name, setup) {
  describe(`forum contract: ${name}`, () => {
    async function open(options) {
      return createForum({ forumDir: await setup.forumDir(), adapter: setup.adapter, ...options })
    }

    // Asserts that fn leaves every listed record in place and appends nothing. Cursors are opaque
    // and need not repeat, so only records are compared.
    async function assertUnchanged(forum, fn) {
      const records = async () => [
        ...(await readAll(forum.listTopics, quiet)).items,
        ...(await readAll(forum.listMessages, quiet)).items,
      ]
      const before = await records()
      await fn()
      assert.deepEqual(await records(), before)
    }

    test('creates topics with and without an initial message', async () => {
      const forum = await open()
      const plain = await forum.createTopic({ title: 'Flaky tests', author: 'alice' })
      assert.equal(plain.message, null)
      assert.deepEqual(Object.keys(plain), ['topic', 'message'])
      assert.deepEqual(Object.keys(plain.topic), ['id', 'title', 'created_by', 'created_at'])
      assert.match(plain.topic.id, UUID)
      assert.match(plain.topic.created_at, ISO)

      const body = '  Report findings here.\n\n  Keep indentation.  '
      const { topic, message } = await forum.createTopic({
        title: 'Investigate',
        author: 'sess-1',
        body,
        originSessionId: 'sess-1',
      })
      assert.equal(topic.origin_session_id, 'sess-1')
      assert.deepEqual(Object.keys(message), ['id', 'topic_id', 'author', 'body', 'created_at', 'origin_session_id'])
      assert.equal(message.topic_id, topic.id)
      assert.equal(message.body, body)
      assert.deepEqual(await forum.getTopic(topic.id), topic)
      assert.deepEqual(await forum.getMessage(message.id), message)
      assert.deepEqual((await forum.listTopics()).items, [plain.topic, topic])
    })

    test('posts messages and same-topic replies, and gets complete records', async () => {
      const forum = await open()
      const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
      const first = await forum.postMessage({ topicId: topic.id, author: 'a', body: 'first' })
      assert.equal(first.reply_to, undefined)
      assert.equal(first.origin_session_id, undefined)
      const body = `${'x'.repeat(64 * 1024 - 4)}🧵`
      const reply = await forum.postMessage({
        topicId: topic.id,
        author: 'b',
        body,
        replyTo: first.id,
        originSessionId: 'sess-b',
      })
      assert.equal(reply.reply_to, first.id)
      assert.equal(reply.origin_session_id, 'sess-b')
      const got = await forum.getMessage(reply.id)
      assert.deepEqual(got, reply)
      assert.equal(Buffer.byteLength(got.body), 64 * 1024)
      assert.deepEqual((await forum.listMessages({ topicId: topic.id })).items, [first, reply])
    })

    test('reports missing topics and messages as NOT_FOUND', async () => {
      const forum = await open()
      const { topic, message } = await forum.createTopic({ title: 'T', author: 'a', body: 'b' })
      await assert.rejects(forum.getTopic('nope'), { code: 'NOT_FOUND', message: 'topic nope not found' })
      await assert.rejects(forum.getMessage('nope'), { code: 'NOT_FOUND', message: 'message nope not found' })
      // Topic and message IDs are separate.
      await assert.rejects(forum.getMessage(topic.id), forumError('NOT_FOUND'))
      await assert.rejects(forum.getTopic(message.id), forumError('NOT_FOUND'))
      await assert.rejects(forum.getMessage(''), forumError('INVALID_INPUT'))
      await assert.rejects(forum.getMessage(42), forumError('INVALID_INPUT'))
      await assert.rejects(forum.getTopic(' '), forumError('INVALID_INPUT'))
    })

    test('invalid references append nothing', async () => {
      const forum = await open()
      const { topic, message } = await forum.createTopic({ title: 'A', author: 'a', body: 'in A' })
      const { topic: other } = await forum.createTopic({ title: 'B', author: 'a' })
      await assertUnchanged(forum, async () => {
        await assert.rejects(forum.postMessage({ topicId: 'missing', author: 'a', body: 'x' }), {
          code: 'NOT_FOUND',
          message: 'topic missing not found',
        })
        await assert.rejects(forum.postMessage({ topicId: topic.id, author: 'a', body: 'x', replyTo: 'missing' }), {
          code: 'NOT_FOUND',
          message: 'message missing not found',
        })
        await assert.rejects(
          forum.postMessage({ topicId: other.id, author: 'a', body: 'x', replyTo: message.id }),
          forumError('INVALID_INPUT'),
        )
        await assert.rejects(
          forum.postMessage({ topicId: topic.id, author: 'a', body: 'x', replyTo: topic.id }),
          forumError('NOT_FOUND'),
        )
      })
    })

    test('rejects invalid input, limits and cursors without appending', async () => {
      const forum = await open()
      const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
      await assertUnchanged(forum, async () => {
        for (const input of [
          undefined,
          {},
          { title: ' \n\t', author: 'a' },
          { title: 'T', author: '  ' },
          { title: 'T', author: 'a', body: '   ' },
          { title: 'T', author: 'a', body: 42 },
          { title: 'x'.repeat(257), author: 'a' },
          { title: 'T', author: 'é'.repeat(257) },
          { title: 'T', author: 'a', originSessionId: ' ' },
          { title: 'T\uD800', author: 'a' },
        ]) {
          await assert.rejects(forum.createTopic(input), forumError('INVALID_INPUT'), JSON.stringify(input))
        }
        for (const input of [
          { topicId: topic.id, author: 'a', body: '' },
          { topicId: topic.id, author: 'a' },
          { topicId: '', author: 'a', body: 'b' },
          { topicId: topic.id, author: 'a', body: 'b', replyTo: '' },
          { topicId: topic.id, author: 'a', body: '€'.repeat(21846) },
        ]) {
          await assert.rejects(forum.postMessage(input), forumError('INVALID_INPUT'), JSON.stringify(input).slice(0, 80))
        }
        for (const limit of [0, 101, 1.5, '5', -1, Number.NaN]) {
          await assert.rejects(forum.listTopics({ limit }), forumError('INVALID_INPUT'), String(limit))
          await assert.rejects(forum.listMessages({ limit }), forumError('INVALID_INPUT'), String(limit))
        }
        await assert.rejects(forum.listMessages({ topicId: ' ' }), forumError('INVALID_INPUT'))
        for (const after of ['', 42, {}, 'not a cursor!', 'abc']) {
          await assert.rejects(forum.listTopics({ after }), forumError('INVALID_CURSOR'), String(after))
          await assert.rejects(forum.listMessages({ after }), forumError('INVALID_CURSOR'), String(after))
        }
      })
      for (const forumDir of ['relative/forum', '', undefined, 42]) {
        assert.throws(() => createForum({ forumDir, adapter: setup.adapter }), forumError('INVALID_INPUT'))
      }
    })

    test('default and maximum limits', async () => {
      const forum = await open()
      const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
      for (let i = 1; i < 25; i++) await forum.createTopic({ title: `T${i}`, author: 'a' })
      for (let i = 0; i < 110; i++) await forum.postMessage({ topicId: topic.id, author: 'a', body: `m${i}` })
      assert.equal((await forum.listTopics()).items.length, 20)
      assert.equal((await forum.listMessages()).items.length, 50)
      assert.equal((await forum.listTopics({ limit: 1 })).items.length, 1)
      assert.equal((await forum.listMessages({ limit: 100 })).items.length, 100)
      assert.equal((await forum.listMessages({ limit: null })).items.length, 50)
    })

    test('paginates in append order and picks up later appends', async () => {
      const forum = await open()
      const topics = []
      for (const title of ['Ünïcödé', '日本語', '🧪 tests']) {
        topics.push((await forum.createTopic({ title, author: 'ä', body: `${title} 🚀` })).topic)
      }
      const messages = []
      for (let i = 0; i < 7; i++) {
        messages.push(await forum.postMessage({ topicId: topics[i % 3].id, author: 'β', body: `${i}: 👋\n✓` }))
      }
      const allTopics = await readAll(forum.listTopics, { limit: 2 })
      assert.deepEqual(allTopics.items, topics)
      const allMessages = await readAll(forum.listMessages, { limit: 3 })
      assert.equal(allMessages.items.length, 10)
      assert.deepEqual(allMessages.items.slice(3), messages)

      const target = topics[1]
      const filtered = await readAll(forum.listMessages, { topicId: target.id, limit: 1 })
      assert.deepEqual(filtered.items, allMessages.items.filter((m) => m.topic_id === target.id))

      const later = await forum.postMessage({ topicId: target.id, author: 'γ', body: 'später' })
      const newTopic = (await forum.createTopic({ title: 'новая', author: 'δ' })).topic
      assert.deepEqual((await forum.listMessages({ after: filtered.cursor, topicId: target.id })).items, [later])
      assert.deepEqual((await forum.listMessages({ after: allMessages.cursor })).items, [later])
      assert.deepEqual((await forum.listTopics({ after: allTopics.cursor })).items, [newTopic])
    })

    test('an unknown topic lists no messages', async () => {
      const forum = await open()
      const { topic } = await forum.createTopic({ title: 'T', author: 'a', body: 'b' })
      const page = await forum.listMessages({ topicId: 'unknown' })
      assert.deepEqual(page.items, [])
      assert.equal(typeof page.next_cursor, 'string')
      const message = await forum.postMessage({ topicId: topic.id, author: 'a', body: 'c' })
      assert.deepEqual((await forum.listMessages({ after: page.next_cursor })).items, [message])
    })

    test('cursors belong to one forum', async () => {
      const a = await open()
      const b = await open()
      await a.createTopic({ title: 'A', author: 'a' })
      await b.createTopic({ title: 'B', author: 'a' })
      const { next_cursor } = await a.listTopics({ limit: 1 })
      await assert.rejects(b.listTopics({ after: next_cursor }), forumError('INVALID_CURSOR'))
      assert.deepEqual((await a.listTopics({ after: next_cursor })).items, [])
    })

    test('reads do not create an absent forum unless asked to', async () => {
      const forumDir = await setup.forumDir()
      const forum = createForum({ forumDir, adapter: setup.adapter })
      const unavailable = forumError('FORUM_UNAVAILABLE')
      await assert.rejects(forum.listTopics(), unavailable)
      await assert.rejects(forum.listMessages(), unavailable)
      await assert.rejects(forum.getTopic('t'), unavailable)
      await assert.rejects(forum.getMessage('m'), unavailable)
      assert.equal(await setup.exists(forumDir), false)

      const creating = createForum({ forumDir, adapter: setup.adapter, createOnRead: true })
      const empty = await creating.listTopics()
      assert.deepEqual(empty.items, [])
      assert.equal(await setup.exists(forumDir), true)
      // An existing empty forum is readable without createOnRead.
      assert.deepEqual((await forum.listMessages({ after: empty.next_cursor })).items, [])
      await assert.rejects(forum.getTopic('t'), forumError('NOT_FOUND'))
    })

    test('a client reports its directory and pins the forum on first successful access', async () => {
      const forumDir = await setup.forumDir()
      const forum = createForum({ forumDir, adapter: setup.adapter })
      assert.equal(forum.forumDir, forumDir)
      assert.equal(forum.resolved, undefined)
      await assert.rejects(forum.listTopics(), forumError('FORUM_UNAVAILABLE'))
      assert.equal(forum.resolved, undefined)
      await forum.createTopic({ title: 'T', author: 'a' })
      assert.equal(typeof forum.resolved, 'string')
      const { resolved } = forum
      await forum.listTopics()
      assert.equal(forum.resolved, resolved)
    })

    test('aborted reads report ABORTED and return nothing', async () => {
      const writer = await open()
      const { topic, message } = await writer.createTopic({ title: 'T', author: 'a', body: 'b' })
      const reads = (forum, signal) => [
        forum.listTopics({ signal }),
        forum.listMessages({ topicId: topic.id, signal }),
        forum.getTopic(topic.id, { signal }),
        forum.getMessage(message.id, { signal }),
      ]
      // Settles all the reads together, so none rejects before a handler is attached, and checks
      // that each was rejected as expected.
      const assertAllRejected = async (promises, check) => {
        const results = await Promise.allSettled(promises)
        for (const result of results) {
          assert.equal(result.status, 'rejected')
          assert.ok(check(result.reason))
        }
      }
      const aborted = (reason) => (err) => {
        assert.ok(err instanceof ForumError)
        assert.equal(err.code, 'ABORTED')
        assert.equal(err.cause, reason)
        return true
      }

      const reader = createForum({ forumDir: writer.forumDir, adapter: setup.adapter })
      const before = new AbortController()
      before.abort(new Error('before'))
      await assertAllRejected(reads(reader, before.signal), aborted(before.signal.reason))

      // Aborting just after the calls start, while they are opening or reading.
      const during = new AbortController()
      const started = reads(reader, during.signal)
      during.abort(new Error('during'))
      await assertAllRejected(started, aborted(during.signal.reason))
      assert.equal(reader.resolved, undefined)

      for (const signal of ['abort', {}, 1]) {
        await assertAllRejected(reads(reader, signal), forumError('INVALID_INPUT'))
      }
      const [topics, messages, gotTopic, gotMessage] = await Promise.all(reads(reader, new AbortController().signal))
      assert.deepEqual(topics.items, [topic])
      assert.deepEqual(messages.items, [message])
      assert.deepEqual(gotTopic, topic)
      assert.deepEqual(gotMessage, message)
    })

    test('writes create an absent forum', async () => {
      const forumDir = await setup.forumDir()
      const forum = createForum({ forumDir, adapter: setup.adapter })
      const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
      assert.equal(await setup.exists(forumDir), true)
      assert.deepEqual(await forum.getTopic(topic.id), topic)
    })

    test('a failed append is reported and appends nothing', async (t) => {
      const forum = await open()
      const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
      setup.failAppends(t, 'message_posted')
      await assertUnchanged(forum, async () => {
        await assert.rejects(forum.postMessage({ topicId: topic.id, author: 'a', body: 'x' }), forumError('WRITE_FAILED'))
      })
    })

    test('a failed initial message reports the created topic', async (t) => {
      const forum = await open()
      setup.failAppends(t, 'message_posted')
      let created
      await assert.rejects(forum.createTopic({ title: 'Partial', author: 'a', body: 'lost' }), (err) => {
        assert.ok(err instanceof ForumError)
        assert.equal(err.code, 'PARTIAL_WRITE')
        assert.equal(err.cause.code, 'WRITE_FAILED')
        assert.match(err.message, new RegExp(`topic ${err.topic.id} was created`))
        created = err.topic
        return true
      })
      assert.deepEqual(await forum.getTopic(created.id), created)
      assert.deepEqual((await forum.listMessages()).items, [])
    })

    test('concurrent writes keep distinct records', async () => {
      const forum = await open()
      const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
      const posted = await Promise.all(
        Array.from({ length: 20 }, (_, i) => forum.postMessage({ topicId: topic.id, author: 'a', body: `${i}` })),
      )
      const listed = (await forum.listMessages({ limit: 100 })).items
      assert.equal(listed.length, 20)
      assert.deepEqual(new Set(listed.map((m) => m.id)), new Set(posted.map((m) => m.id)))
    })
  })
}

contract('jsonl', jsonlSetup)
contract('fake', fakeSetup())

describe('jsonl adapter through createForum', () => {
  test('is the default and reads an existing v1 log without writing', async () => {
    const forumDir = await jsonlSetup.forumDir()
    await fs.mkdir(forumDir)
    const topic = { id: 't1', title: 'Old', created_by: 'a', created_at: '2026-01-01T00:00:00.000Z' }
    const message = { id: 'm1', topic_id: 't1', author: 'a', body: 'hi', created_at: '2026-01-01T00:00:01.000Z' }
    const log = `${JSON.stringify({ type: 'topic_created', ...topic })}\n${JSON.stringify({ type: 'message_posted', ...message })}\n`
    await fs.writeFile(path.join(forumDir, 'events.jsonl'), log)
    const forum = createForum({ forumDir })
    const page = await forum.listTopics()
    assert.deepEqual(page.items, [topic])
    const cursor = JSON.parse(Buffer.from(page.next_cursor, 'base64url').toString('utf8'))
    assert.deepEqual(Object.keys(cursor), ['v', 'forum', 'offset'])
    assert.equal(cursor.offset, Buffer.byteLength(log))
    assert.deepEqual(await forum.getMessage('m1'), message)
    assert.deepEqual((await forum.listMessages({ topicId: 't1' })).items, [message])
    assert.deepEqual(await fs.readdir(forumDir), ['events.jsonl'])
    assert.equal(await fs.readFile(path.join(forumDir, 'events.jsonl'), 'utf8'), log)
  })

  test('getMessage skips damaged records with warnings', async () => {
    const forumDir = await jsonlSetup.forumDir()
    const forum = createForum({ forumDir })
    const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
    const offset = (await fs.stat(path.join(forumDir, 'events.jsonl'))).size
    await fs.appendFile(path.join(forumDir, 'events.jsonl'), 'not json\n')
    const message = await forum.postMessage({ topicId: topic.id, author: 'a', body: 'b' }, quiet)
    const warnings = []
    const onWarning = (warning) => warnings.push(warning)
    assert.deepEqual(await forum.getMessage(message.id, { onWarning }), message)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], new RegExp(`^skipping malformed record at byte offset ${offset}:`))
    await assert.rejects(forum.getMessage('missing', quiet), forumError('NOT_FOUND'))
  })
})

describe('client identity', () => {
  // An adapter whose forum identity the test controls; it leaves pin checks to the facade.
  function switchingAdapter() {
    const state = { identity: 'A', fail: false, opened: [], appended: [] }
    state.adapter = {
      async open({ identity }) {
        state.opened.push(identity)
        if (state.fail) throw new ForumError('FORUM_UNAVAILABLE', 'unreachable')
        return {
          identity: state.identity,
          async read() {
            return 'cursor'
          },
          write: (options, fn) => fn({ read() {}, append: async (event) => state.appended.push(event) }),
        }
      },
    }
    return state
  }

  test('a failed first access pins nothing', async () => {
    const state = switchingAdapter()
    const forum = createForum({ forumDir: '/forum', adapter: state.adapter })
    state.fail = true
    await assert.rejects(forum.listTopics(), forumError('FORUM_UNAVAILABLE'))
    assert.equal(forum.resolved, undefined)
    state.fail = false
    state.identity = 'B'
    await forum.listTopics()
    assert.equal(forum.resolved, 'B')
    assert.deepEqual(state.opened, [undefined, undefined])
  })

  test('a pinned client refuses another forum, and a new client accepts it', async () => {
    const state = switchingAdapter()
    const forum = createForum({ forumDir: '/forum', adapter: state.adapter })
    await assert.rejects(forum.getTopic('t'), forumError('NOT_FOUND'))
    assert.equal(forum.resolved, 'A')
    state.identity = 'B'
    const moved = forumError('FORUM_UNAVAILABLE')
    await assert.rejects(forum.listTopics(), moved)
    await assert.rejects(forum.listMessages(), moved)
    await assert.rejects(forum.getTopic('t'), moved)
    await assert.rejects(forum.getMessage('m'), moved)
    await assert.rejects(forum.createTopic({ title: 'T', author: 'a' }), moved)
    await assert.rejects(forum.postMessage({ topicId: 't', author: 'a', body: 'b' }), moved)
    assert.deepEqual(state.appended, [])
    assert.equal(forum.resolved, 'A')
    assert.deepEqual(new Set(state.opened.slice(1)), new Set(['A']))

    const again = createForum({ forumDir: '/forum', adapter: state.adapter })
    await again.createTopic({ title: 'T', author: 'a' })
    assert.equal(again.resolved, 'B')
    assert.equal(state.appended.length, 1)
  })
})

describe('a custom adapter append that throws a non-Error', () => {
  // An adapter that appends a topic and then throws thrown, as a custom adapter may.
  function throwingAdapter(thrown) {
    return {
      async open({ forumDir }) {
        return {
          identity: forumDir,
          async read() {
            return 'cursor'
          },
          write: (options, fn) =>
            fn({
              read() {},
              async append(event) {
                if (event.type === 'message_posted') throw thrown
              },
            }),
        }
      },
    }
  }
  const createWith = (thrown) =>
    createForum({ forumDir: '/forum', adapter: throwingAdapter(thrown) }).createTopic({ title: 'T', author: 'a', body: 'b' })

  // The partial write's message reads thrown.message as JavaScript does, so null and undefined fail
  // while it is built.
  for (const [name, thrown] of [
    ['null', null],
    ['undefined', undefined],
  ]) {
    test(`${name} fails reading its message`, async () => {
      await assert.rejects(createWith(thrown), (err) => {
        assert.ok(err instanceof TypeError)
        assert.equal(err.message, `Cannot read properties of ${name} (reading 'message')`)
        return true
      })
    })
  }

  for (const [name, thrown, message] of [
    ['a function with a message', Object.assign(() => {}, { message: 'function failed' }), 'function failed'],
    ['an object with a message', { message: 'object failed' }, 'object failed'],
    ['an object with an inherited message', Object.create({ message: 'inherited failed' }), 'inherited failed'],
    ['an object without a message', {}, 'undefined'],
    ['a boxed string with a message', Object.assign(new String('boxed'), { message: 'boxed failed' }), 'boxed failed'],
    ['a string', 'plain', 'undefined'],
    ['a number', 42, 'undefined'],
  ]) {
    test(`${name} is a partial write with its message`, async () => {
      await assert.rejects(createWith(thrown), (err) => {
        assert.ok(err instanceof ForumError)
        assert.equal(err.code, 'PARTIAL_WRITE')
        assert.equal(err.cause, thrown)
        assert.equal(err.message, `topic ${err.topic.id} was created but its initial message was not appended: ${message}`)
        return true
      })
    })
  }
})

describe('read cancellation', () => {
  // An adapter whose single event is read by a store that records its options and can abort the
  // caller's controller once it has visited the event.
  function recordingAdapter(onRead = () => {}) {
    const seen = []
    const event = { type: 'topic_created', data: { id: 't', title: 'T', created_by: 'a', created_at: 'z' } }
    const adapter = {
      async open() {
        return {
          identity: 'forum',
          async read(options, visit) {
            seen.push(options.signal)
            visit(event)
            onRead()
            return 'cursor'
          },
        }
      },
    }
    return { adapter, seen }
  }

  test('lists and getters pass their signal to the store', async () => {
    const { adapter, seen } = recordingAdapter()
    const forum = createForum({ forumDir: '/forum', adapter })
    const { signal } = new AbortController()
    await forum.listTopics({ signal })
    await forum.listMessages({ signal })
    await forum.getTopic('t', { signal })
    await assert.rejects(forum.getMessage('m', { signal }), forumError('NOT_FOUND'))
    await forum.listTopics()
    assert.deepEqual(seen, [signal, signal, signal, signal, undefined])
  })

  test('an abort while the store reads discards its complete result', async () => {
    const controller = new AbortController()
    const { adapter } = recordingAdapter(() => controller.abort())
    const forum = createForum({ forumDir: '/forum', adapter })
    await assert.rejects(forum.listTopics({ signal: controller.signal }), forumError('ABORTED'))
    assert.equal(forum.resolved, undefined)
    const again = new AbortController()
    const { adapter: other } = recordingAdapter(() => again.abort())
    await assert.rejects(
      createForum({ forumDir: '/forum', adapter: other }).getTopic('t', { signal: again.signal }),
      forumError('ABORTED'),
    )
  })
})
