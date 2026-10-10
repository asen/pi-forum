import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from '../src/cli.js'
import type { Environment, ForumFactory } from '../src/cli.js'
import { createForum } from '../src/forum.js'
import { createTopic, postMessage } from '../src/storage.js'
import type {
  CreateForumOptions,
  CreateTopicResult,
  Forum,
  Message,
  Page,
  ReadCallOptions,
  Topic,
  WriteCallOptions,
} from '../src/types.js'
import { fakeAdapter } from './fake-adapter.ts'
import type { FakeAdapter } from './fake-adapter.ts'

const BIN = fileURLToPath(new URL('../bin/pi-forum', import.meta.url))
const FAIL_MESSAGE_APPEND = fileURLToPath(new URL('./fixtures/fail-message-append.mts', import.meta.url))
const roots: string[] = []

after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-cli-test-'))
  roots.push(root)
  return root
}

async function tempForum() {
  return path.join(await tempRoot(), 'forum')
}

interface RunOptions {
  env?: Environment
  input?: string
  cwd?: string
  nodeArgs?: string[]
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

// What each command prints on success, by its two command words, as the help documents.
interface Responses {
  topic: { create: CreateTopicResult; get: { topic: Topic }; list: Page<Topic> }
  message: { post: { message: Message }; get: { message: Message }; list: Page<Message> }
}

// The arguments of a command that prints a response: its two command words, then the rest.
type CommandArgs<G extends keyof Responses, V extends keyof Responses[G] & string> = readonly [G, V, ...string[]]

// One line of the log as stored: an event's type beside its record's fields.
type StoredEvent = (Topic & { type: 'topic_created' }) | (Message & { type: 'message_posted' })

// Runs the executable with only PATH plus the given environment, so the caller's Pi variables never leak in.
function run(args: readonly string[], { env = {}, input, cwd, nodeArgs }: RunOptions = {}): Promise<RunResult> {
  const fullEnv = { PATH: process.env.PATH, ...env }
  const [file, argv] = nodeArgs ? [process.execPath, [...nodeArgs, BIN, ...args]] : [BIN, args]
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { env: fullEnv, cwd })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
    child.stdin.end(input)
  })
}

// Runs a command expected to succeed and returns its single JSON result. Parsing it as the command's
// documented response is the only unchecked step; the tests assert the fields they use.
async function ok<G extends keyof Responses, V extends keyof Responses[G] & string>(
  args: CommandArgs<G, V>,
  options?: RunOptions,
): Promise<Responses[G][V]> {
  const result = await run(args, options)
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  assert.ok(result.stdout.endsWith('\n'))
  assert.equal(result.stdout.indexOf('\n'), result.stdout.length - 1, 'stdout is one line')
  return JSON.parse(result.stdout)
}

// Runs a command expected to fail and returns its stderr.
async function fails(args: readonly string[], options: RunOptions, pattern?: RegExp) {
  const result = await run(args, options)
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^pi-forum: error: /)
  if (pattern) assert.match(result.stderr, pattern)
  return result.stderr
}

const forumEnv = (dir: string, extra: Environment = {}) => ({ env: { PI_FORUM_DIR: dir, ...extra } })
const logPath = (dir: string) => path.join(dir, 'events.jsonl')
const readLog = (dir: string) =>
  fs.readFile(logPath(dir), 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)))
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function readAll<G extends keyof Responses>(args: CommandArgs<G, 'list'>, options: RunOptions, cursor?: string) {
  const items: Responses[G]['list']['items'][number][] = []
  for (;;) {
    const page = await ok([...args, ...(cursor ? ['--after', cursor] : [])], options)
    assert.deepEqual(Object.keys(page), ['items', 'next_cursor'])
    items.push(...page.items)
    if (page.items.length === 0) return { items, cursor: page.next_cursor }
    cursor = page.next_cursor
  }
}

describe('help and binding', () => {
  test('help works without a forum binding and documents behavior', async () => {
    for (const args of [['--help'], ['-h'], ['help'], ['topic', 'create', '--help'], ['message', 'post', 'x', '-h']]) {
      const result = await run(args)
      assert.equal(result.code, 0)
      assert.equal(result.stderr, '')
      for (const text of [
        'PI_FORUM_DIR',
        'PI_SESSION_ID',
        '--body-file',
        '--body-stdin',
        'next_cursor',
        '--after',
        'pi-forum message get MESSAGE_ID',
        'message get     {"message": Message}',
      ]) {
        assert.ok(result.stdout.includes(text), `help mentions ${text}`)
      }
    }
  })

  test('missing command and unknown commands are usage errors', async () => {
    await fails([], {}, /missing command\nRun "pi-forum --help" for usage\.\n$/)
    await fails(['topic'], {}, /unknown command "topic"/)
    await fails(['topic', 'delete', 'x'], {}, /unknown command "topic delete"/)
    await fails(['forum', 'list'], {}, /unknown command "forum list"/)
  })

  test('requires a nonempty absolute PI_FORUM_DIR and never picks another path', async () => {
    const cwd = await tempRoot()
    await fails(['topic', 'list'], { cwd }, /PI_FORUM_DIR is not set/)
    await fails(['topic', 'list'], { cwd, env: { PI_FORUM_DIR: '' } }, /PI_FORUM_DIR is not set/)
    await fails(['topic', 'create', 'T'], { cwd, env: { PI_FORUM_DIR: 'forum' } }, /must be an absolute path, got "forum"/)
    await fails(['topic', 'create', 'T'], { cwd, env: { PI_FORUM_DIR: ' /x' } }, /must be an absolute path/)
    assert.deepEqual(await fs.readdir(cwd), [])
  })

  test('usage errors are reported before the binding is checked', async () => {
    await fails(['message', 'post', 'id', '--body', 'a', '--body-stdin'], {}, /use only one of --body, --body-stdin/)
    await fails(['topic', 'list', '--limit', 'x'], {}, /--limit must be an integer/)
  })

  test('help is recognized in option positions without touching the forum', async () => {
    const dir = await tempForum()
    const forms = [
      ['--help'],
      ['-h'],
      ['help'],
      ['topic', '--help'],
      ['message', '-h'],
      ['topic', 'create', '--help'],
      ['topic', 'create', '-h'],
      ['topic', 'create', 'Example', '--body', 'text', '--author', 'a', '--help'],
      ['topic', 'get', '-h'],
      ['topic', 'list', '--help', '--help'],
      ['message', 'post', '-h'],
      ['message', 'post', 'x', '--help'],
      ['message', 'list', '--topic', 't', '--limit', '5', '--after', 'c', '-h'],
      ['message', 'get', '-h'],
      ['message', 'get', 'x', '--help'],
    ]
    for (const args of forms) {
      const result = await run(args, forumEnv(dir))
      assert.equal(result.code, 0, args.join(' '))
      assert.equal(result.stderr, '')
      assert.match(result.stdout, /^Usage:\n {2}pi-forum topic create/)
    }
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' })
  })

  test('help-like option values and invalid flags are errors even with help', async () => {
    const dir = await tempForum()
    const ambiguous = /Option '--[a-z-]+' argument is ambiguous/
    const cases: [string[], RegExp][] = [
      [['topic', 'create', 'Example', '--body', '--help'], ambiguous],
      [['topic', 'create', 'Example', '--body', '-h'], ambiguous],
      [['topic', 'create', 'Example', '--body-file', '--help'], ambiguous],
      [['topic', 'create', 'Example', '--body-file', '-h'], ambiguous],
      [['topic', 'create', 'Example', '--author', '--help'], ambiguous],
      [['topic', 'create', 'Example', '--author', '-h'], ambiguous],
      [['message', 'post', 'x', '--body', '--help'], ambiguous],
      [['message', 'post', 'x', '--body-file', '-h'], ambiguous],
      [['message', 'post', 'x', '--body', 'a', '--author', '--help'], ambiguous],
      [['message', 'post', 'x', '--body', 'a', '--reply-to', '-h'], ambiguous],
      [['topic', 'list', '--after', '--help'], ambiguous],
      [['topic', 'list', '--after', '-h'], ambiguous],
      [['message', 'list', '--after', '--help'], ambiguous],
      [['message', 'list', '--after', '-h'], ambiguous],
      [['message', 'list', '--topic', '--help'], ambiguous],
      [['topic', 'list', '--limit', '-h'], ambiguous],
      [['topic', 'list', '--help', '--after'], /argument missing/],
      [['topic', 'create', 'X', '--bogus', '--help'], /Unknown option '--bogus'/],
      [['topic', 'create', '--help', '--bogus'], /Unknown option '--bogus'/],
      [['message', 'list', '-h', '-x'], /Unknown option '-x'/],
      [['topic', 'create', 'X', '--help=yes'], /does not take an argument/],
      [['topic', 'create', 'X', '--author', 'a', '--author', 'b', '--help'], /--author may be given only once/],
      [['message', 'list', '--after', 'a', '--after', 'b', '-h'], /--after may be given only once/],
      [['message', 'post', 'x', '--body', 'a', '--body-stdin', '--help'], /use only one of --body, --body-stdin/],
      [['topic', 'list', '--limit', 'ten', '-h'], /--limit must be an integer/],
      [['topic', 'get', 'a', 'b', '--help'], /unexpected argument "b"/],
      [['message', 'get', 'a', 'b', '-h'], /unexpected argument "b"/],
      [['message', 'get', 'a', '--topic', 't', '--help'], /Unknown option '--topic'/],
      [['topic', 'delete', '--help'], /unknown command "topic delete"/],
    ]
    for (const [args, pattern] of cases) await fails(args, forumEnv(dir), pattern)
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' })
  })

  test('help-like text is literal after = or --', async () => {
    const dir = await tempForum()
    const cwd = await tempRoot()
    await fs.writeFile(path.join(cwd, '--help'), 'from a dash file\n')
    const { topic, message } = await ok(['topic', 'create', '--body=--help', '--author=-h', '--', '--help'], forumEnv(dir))
    assert.equal(topic.title, '--help')
    assert.equal(topic.created_by, '-h')
    assert.equal(message!.body, '--help')
    assert.equal((await ok(['topic', 'create', '--', '-h'], forumEnv(dir))).topic.title, '-h')
    const fromFile = await ok(['message', 'post', '--body-file=--help', '--', topic.id], { cwd, ...forumEnv(dir) })
    assert.equal(fromFile.message.body, 'from a dash file\n')
    assert.deepEqual(await ok(['topic', 'get', '--', topic.id], forumEnv(dir)), { topic })
    assert.deepEqual((await ok(['message', 'list', '--topic=--help'], forumEnv(dir))).items, [])
    await fails(['topic', 'list', '--after=-h'], forumEnv(dir), /cursor is not valid/)
    await fails(['topic', 'get', '--', '--help'], forumEnv(dir), /topic --help not found/)
  })
})

describe('topic commands', () => {
  test('create without a body uses the session identity', async () => {
    const dir = await tempForum()
    const result = await ok(['topic', 'create', 'Flaky tests'], forumEnv(dir, { PI_SESSION_ID: 'sess-1' }))
    assert.deepEqual(Object.keys(result), ['topic', 'message'])
    assert.equal(result.message, null)
    assert.match(result.topic.id, UUID)
    assert.equal(result.topic.title, 'Flaky tests')
    assert.equal(result.topic.created_by, 'sess-1')
    assert.equal(result.topic.origin_session_id, 'sess-1')
    assert.deepEqual(await ok(['topic', 'get', result.topic.id], forumEnv(dir)), { topic: result.topic })
  })

  test('create with --body preserves whitespace and UTF-8; explicit author keeps the origin session', async () => {
    const dir = await tempForum()
    const title = '  Ünïcödé 🧪 тема  '
    const body = '\n  Report findings here.\r\n\tKeep indentation 👍  \n\n'
    const { topic, message } = await ok(
      ['topic', 'create', title, '--body', body, '--author', ' reviewer '],
      forumEnv(dir, { PI_SESSION_ID: 'sess-2' }),
    )
    assert.equal(topic.title, title)
    assert.equal(topic.created_by, ' reviewer ')
    assert.equal(topic.origin_session_id, 'sess-2')
    assert.equal(message!.topic_id, topic.id)
    assert.equal(message!.body, body)
    assert.equal(message!.author, ' reviewer ')
    assert.equal(message!.origin_session_id, 'sess-2')
    assert.deepEqual((await ok(['message', 'list'], forumEnv(dir))).items, [message])
  })

  test('create reads --body-file relative to the caller cwd', async () => {
    const dir = await tempForum()
    const cwd = await tempRoot()
    const body = 'Fichier ✓\n  second line\n'
    await fs.mkdir(path.join(cwd, 'notes'))
    await fs.writeFile(path.join(cwd, 'notes', 'body.md'), body)
    const { message } = await ok(['topic', 'create', 'From file', '--body-file', 'notes/body.md'], { cwd, ...forumEnv(dir) })
    assert.equal(message!.body, body)
  })

  test('create reads --body-stdin exactly', async () => {
    const dir = await tempForum()
    const body = '﻿  stdin 本文\n\n'
    const { message } = await ok(['topic', 'create', 'From stdin', '--body-stdin'], { input: body, ...forumEnv(dir) })
    assert.equal(message!.body, body)
  })

  test('callers without session metadata are external with no origin', async () => {
    const dir = await tempForum()
    for (const env of [{}, { PI_SESSION_ID: '' }, { PI_SESSION_ID: '  \t' }]) {
      const { topic, message } = await ok(['topic', 'create', 'Manual', '--body', 'hi'], forumEnv(dir, env))
      assert.equal(topic.created_by, 'external')
      assert.equal(message!.author, 'external')
      assert.equal('origin_session_id' in topic, false)
      assert.equal('origin_session_id' in message!, false)
    }
    const { topic } = await ok(['topic', 'create', 'Labelled', '--author', 'human'], forumEnv(dir))
    assert.deepEqual(Object.keys(topic), ['id', 'title', 'created_by', 'created_at'])
    assert.equal(topic.created_by, 'human')
  })

  test('titles and IDs starting with a dash can follow --', async () => {
    const dir = await tempForum()
    const { topic } = await ok(['topic', 'create', '--body=-starts with dash', '--', '-dash title'], forumEnv(dir))
    assert.equal(topic.title, '-dash title')
    await fails(['topic', 'get', '--', '-missing'], forumEnv(dir), /topic -missing not found/)
  })

  test('get reports unknown topics', async () => {
    const dir = await tempForum()
    await fails(['topic', 'get', 'nope'], forumEnv(dir), /topic nope not found/)
    await fails(['topic', 'get', '  '], forumEnv(dir), /topicId must be a non-blank string/)
  })

  test('list paginates in creation order and resumes from EOF after later appends', async () => {
    const dir = await tempForum()
    const titles = ['one', 'two ✨', 'three']
    for (const title of titles) await ok(['topic', 'create', title], forumEnv(dir))
    const first = await ok(['topic', 'list', '--limit', '2'], forumEnv(dir))
    assert.deepEqual(first.items.map((t) => t.title), titles.slice(0, 2))
    const second = await ok(['topic', 'list', '--limit', '2', '--after', first.next_cursor], forumEnv(dir))
    assert.deepEqual(second.items.map((t) => t.title), ['three'])
    const end = await ok(['topic', 'list', '--after', second.next_cursor], forumEnv(dir))
    assert.deepEqual(end.items, [])
    const again = await ok(['topic', 'list', '--after', end.next_cursor], forumEnv(dir))
    assert.deepEqual(again, end)
    await ok(['topic', 'create', 'four'], forumEnv(dir))
    const later = await ok(['topic', 'list', '--after', end.next_cursor], forumEnv(dir))
    assert.deepEqual(later.items.map((t) => t.title), ['four'])
    assert.deepEqual((await readAll(['topic', 'list', '--limit', '1'], forumEnv(dir))).items.map((t) => t.title), [
      ...titles,
      'four',
    ])
  })

  test('list defaults to 20 topics and accepts limits 1 and 100', async () => {
    const dir = await tempForum()
    for (let i = 0; i < 21; i++) await createTopic(dir, { title: `t${i}`, author: 'seed' })
    assert.equal((await ok(['topic', 'list'], forumEnv(dir))).items.length, 20)
    assert.equal((await ok(['topic', 'list', '--limit', '1'], forumEnv(dir))).items.length, 1)
    assert.equal((await ok(['topic', 'list', '--limit=100'], forumEnv(dir))).items.length, 21)
  })
})

describe('message commands', () => {
  async function seededTopic(dir: string) {
    return (await createTopic(dir, { title: 'Topic', author: 'seed' })).topic
  }

  function seededMessage(dir: string, topic: Topic) {
    return postMessage(dir, { topicId: topic.id, author: 'seed', body: 'seed' })
  }

  test('post from each body source with attribution and replies', async () => {
    const dir = await tempForum()
    const cwd = await tempRoot()
    const topic = await seededTopic(dir)
    const session = { PI_SESSION_ID: 'sess-3' }

    const inline = await ok(['message', 'post', topic.id, '--body', '  inline ✓  '], forumEnv(dir, session))
    assert.deepEqual(Object.keys(inline), ['message'])
    assert.equal(inline.message.body, '  inline ✓  ')
    assert.equal(inline.message.author, 'sess-3')
    assert.equal(inline.message.origin_session_id, 'sess-3')
    assert.equal(inline.message.topic_id, topic.id)
    assert.equal('reply_to' in inline.message, false)

    await fs.writeFile(path.join(cwd, 'reply.txt'), 'file body\n')
    const reply = await ok(
      ['message', 'post', topic.id, '--body-file', 'reply.txt', '--reply-to', inline.message.id, '--author', 'bot'],
      { cwd, ...forumEnv(dir, session) },
    )
    assert.equal(reply.message.body, 'file body\n')
    assert.equal(reply.message.reply_to, inline.message.id)
    assert.equal(reply.message.author, 'bot')
    assert.equal(reply.message.origin_session_id, 'sess-3')

    const piped = await ok(['message', 'post', topic.id, '--body-stdin'], { input: 'piped\r\n', ...forumEnv(dir) })
    assert.equal(piped.message.body, 'piped\r\n')
    assert.equal(piped.message.author, 'external')
    assert.equal('origin_session_id' in piped.message, false)

    const { items } = await ok(['message', 'list', '--topic', topic.id], forumEnv(dir))
    assert.deepEqual(items, [inline.message, reply.message, piped.message])
  })

  test('post reports missing topics and replies', async () => {
    const dir = await tempForum()
    const topic = await seededTopic(dir)
    const other = await seededTopic(dir)
    const elsewhere = await postMessage(dir, { topicId: other.id, author: 'a', body: 'x' })
    const before = await readLog(dir)
    await fails(['message', 'post', 'nope', '--body', 'x'], forumEnv(dir), /topic nope not found/)
    await fails(['message', 'post', topic.id, '--body', 'x', '--reply-to', 'm'], forumEnv(dir), /message m not found/)
    await fails(
      ['message', 'post', topic.id, '--body', 'x', '--reply-to', elsewhere.id],
      forumEnv(dir),
      /belongs to a different topic/,
    )
    assert.equal(await readLog(dir), before)
  })

  test('list reads the whole forum or one topic, paginating and resuming from EOF', async () => {
    const dir = await tempForum()
    const a = await seededTopic(dir)
    const b = await seededTopic(dir)
    for (const [topic, body] of [[a, 'a1'], [b, 'b1'], [a, 'a2 🚀'], [b, 'b2'], [a, 'a3']] as const) {
      await ok(['message', 'post', topic.id, '--body', body], forumEnv(dir))
    }
    const all = await readAll(['message', 'list', '--limit', '2'], forumEnv(dir))
    assert.deepEqual(all.items.map((m) => m.body), ['a1', 'b1', 'a2 🚀', 'b2', 'a3'])

    const first = await ok(['message', 'list', '--topic', a.id, '--limit', '2'], forumEnv(dir))
    assert.deepEqual(first.items.map((m) => m.body), ['a1', 'a2 🚀'])
    const rest = await readAll(['message', 'list', '--topic', a.id], forumEnv(dir), first.next_cursor)
    assert.deepEqual(rest.items.map((m) => m.body), ['a3'])

    await ok(['message', 'post', b.id, '--body', 'b3'], forumEnv(dir))
    await ok(['message', 'post', a.id, '--body', 'a4'], forumEnv(dir))
    const newer = await ok(['message', 'list', '--topic', a.id, '--after', rest.cursor], forumEnv(dir))
    assert.deepEqual(newer.items.map((m) => m.body), ['a4'])
    const newerAll = await ok(['message', 'list', '--after', all.cursor], forumEnv(dir))
    assert.deepEqual(newerAll.items.map((m) => m.body), ['b3', 'a4'])
  })

  test('list for an unknown topic is an empty page', async () => {
    const dir = await tempForum()
    await postMessage(dir, { topicId: (await seededTopic(dir)).id, author: 'a', body: 'x' })
    const page = await ok(['message', 'list', '--topic', 'unknown'], forumEnv(dir))
    assert.deepEqual(page.items, [])
    assert.equal(typeof page.next_cursor, 'string')
  })

  test('get prints one complete stored message', async () => {
    const dir = await tempForum()
    const topic = await seededTopic(dir)
    const bodies = [
      '  leading and trailing whitespace\n\n\t kept  \r\n',
      'Ünïcödé 日本語 🧵\u2028 line separator, ZWJ 👩\u200d💻 and combining e\u0301',
      `${'x'.repeat(64 * 1024 - 4)}🧵`,
    ]
    for (const body of bodies) {
      const posted = await postMessage(dir, { topicId: topic.id, author: 'seed', body, originSessionId: 's' })
      const result = await ok(['message', 'get', posted.id], forumEnv(dir))
      assert.deepEqual(Object.keys(result), ['message'])
      assert.deepEqual(result, { message: posted })
      assert.equal(result.message.body, body)
    }
    assert.equal(Buffer.byteLength(bodies[2]!), 64 * 1024)
    const reply = await ok(['message', 'post', topic.id, '--body', 'r', '--reply-to', (await seededMessage(dir, topic)).id], forumEnv(dir))
    assert.deepEqual(await ok(['message', 'get', '--', reply.message.id], forumEnv(dir)), reply)
  })

  test('get reports unknown messages and writes nothing', async () => {
    const dir = await tempForum()
    const topic = await seededTopic(dir)
    const before = await readLog(dir)
    assert.equal(await fails(['message', 'get', 'nope'], forumEnv(dir)), 'pi-forum: error: message nope not found\n')
    await fails(['message', 'get', topic.id], forumEnv(dir), new RegExp(`message ${topic.id} not found`))
    await fails(['message', 'get', '--', '-h'], forumEnv(dir), /message -h not found/)
    assert.equal(await readLog(dir), before)
  })

  test('list defaults to 50 messages', async () => {
    const dir = await tempForum()
    const topic = await seededTopic(dir)
    for (let i = 0; i < 51; i++) await postMessage(dir, { topicId: topic.id, author: 'seed', body: `m${i}` })
    assert.equal((await ok(['message', 'list'], forumEnv(dir))).items.length, 50)
    assert.equal((await ok(['message', 'list', '--limit', '100'], forumEnv(dir))).items.length, 51)
  })
})

describe('input errors', () => {
  test('argument and body-source errors write nothing', async () => {
    const dir = await tempForum()
    const cwd = await tempRoot()
    const topic = (await createTopic(dir, { title: 'T', author: 'a' })).topic
    await fs.writeFile(path.join(cwd, 'blank.txt'), ' \n\t\n')
    await fs.writeFile(path.join(cwd, 'bad.txt'), Buffer.from([0x68, 0xff, 0x69]))
    const before = await readLog(dir)
    const env = { cwd, ...forumEnv(dir, { PI_SESSION_ID: 's' }) }
    const cases: [string[], RegExp][] = [
      [['topic', 'create'], /missing TITLE for topic create/],
      [['topic', 'create', 'A', 'B'], /unexpected argument "B" for topic create/],
      [['topic', 'create', '   '], /title must be a non-blank string/],
      [['topic', 'create', ''], /title must be a non-blank string/],
      [['topic', 'create', 'A', '--author', ' '], /author must be a non-blank string/],
      [['topic', 'create', 'A', '--author', 'x', '--author', 'y'], /--author may be given only once/],
      [['topic', 'create', 'A', '--body', ''], /body must be a non-blank string/],
      [['topic', 'create', 'A', '--body', ' \n '], /body must be a non-blank string/],
      [['topic', 'create', 'A', '--body-file', 'blank.txt'], /body must be a non-blank string/],
      [['topic', 'create', 'A', '--body-file', 'bad.txt'], /body from .*bad\.txt is not valid UTF-8/],
      [['topic', 'create', 'A', '--body-file', 'missing.txt'], /cannot read body file .*missing\.txt: ENOENT/],
      [['topic', 'create', 'A', '--body', 'x', '--body-file', 'blank.txt'], /use only one of --body, --body-file/],
      [['topic', 'create', 'A', '--body', 'x', '--body', 'y'], /--body may be given only once/],
      [['topic', 'create', 'A', '--body'], /argument missing/],
      [['topic', 'create', 'A', '--body', '-x'], /argument is ambiguous/],
      [['topic', 'create', 'A', '--body-stdin=yes'], /does not take an argument/],
      [['topic', 'create', 'A', '--reply-to', 'm'], /Unknown option '--reply-to'/],
      [['topic', 'create', 'A', '--limit', '5'], /Unknown option '--limit'/],
      [['topic', 'create', '-x'], /Unknown option '-x'/],
      [['topic', 'get'], /missing TOPIC_ID for topic get/],
      [['topic', 'get', topic.id, 'extra'], /unexpected argument "extra"/],
      [['topic', 'list', 'extra'], /unexpected argument "extra" for topic list/],
      [['topic', 'list', '--topic', topic.id], /Unknown option '--topic'/],
      [['message', 'post', topic.id], /a body is required/],
      [['message', 'post', '--body', 'x'], /missing TOPIC_ID for message post/],
      [['message', 'post', topic.id, '--body', '\t'], /body must be a non-blank string/],
      [['message', 'post', topic.id, '--body-stdin', '--body-file', 'blank.txt'], /use only one of --body-file, --body-stdin/],
      [['message', 'post', topic.id, 'extra', '--body', 'x'], /unexpected argument "extra"/],
      [['message', 'post', topic.id, '--body', 'x', '--reply-to', ' '], /replyTo must be a non-blank string/],
      [['message', 'list', '--topic', ''], /topicId must be a non-blank string/],
      [['message', 'list', '--verbose'], /Unknown option '--verbose'/],
      [['message', 'get'], /missing MESSAGE_ID for message get/],
      [['message', 'get', 'a', 'b'], /unexpected argument "b" for message get/],
      [['message', 'get', 'a', '--body', 'x'], /Unknown option '--body'/],
      [['message', 'get', ' '], /messageId must be a non-blank string/],
    ]
    for (const [args, pattern] of cases) {
      const stderr = await fails(args, { ...env, input: ' ' }, pattern)
      assert.doesNotMatch(stderr, /warning/, args.join(' '))
    }
    assert.equal(await readLog(dir), before)
  })

  test('storage caps apply to titles, authors and bodies', async () => {
    const dir = await tempForum()
    await ok(['topic', 'create', '🧪'.repeat(256), '--author', 'é'.repeat(256)], forumEnv(dir))
    await fails(['topic', 'create', 'x'.repeat(257)], forumEnv(dir), /title must be at most 256 characters/)
    await fails(['topic', 'create', 'x', '--author', 'x'.repeat(257)], forumEnv(dir), /author must be at most 256/)
    const big = 'é'.repeat(32 * 1024)
    await ok(['topic', 'create', 'Big', '--body-stdin'], { input: big, ...forumEnv(dir) })
    await fails(['topic', 'create', 'Too big', '--body-stdin'], { input: `${big}x`, ...forumEnv(dir) }, /at most 65536 bytes/)
  })

  test('limits and cursors are validated', async () => {
    const dir = await tempForum()
    for (const limit of ['0', '101', '-1', '1.5', 'ten', '', ' 5', '1e2']) {
      for (const command of [['topic', 'list'], ['message', 'list']]) {
        await fails([...command, `--limit=${limit}`], forumEnv(dir), /limit must be an integer from 1 to 100/)
      }
    }
    await fails(['topic', 'list', '--after', 'not a cursor'], forumEnv(dir), /cursor is not valid/)
    await fails(['message', 'list', '--after', ''], forumEnv(dir), /cursor is not valid/)
    const other = await tempForum()
    const { next_cursor } = await ok(['topic', 'list'], forumEnv(other))
    await fails(['topic', 'list', '--after', next_cursor], forumEnv(dir), /cursor belongs to a different forum/)
  })
})

describe('storage conditions', () => {
  test('warnings go to stderr while the result stays on stdout', async () => {
    const dir = await tempForum()
    await fs.mkdir(dir)
    await fs.writeFile(logPath(dir), 'not json\n')
    const { topic } = await createTopic(dir, { title: 'T', author: 'a' })
    for (const args of [['topic', 'list'], ['topic', 'get', topic.id], ['message', 'list']]) {
      const result = await run(args, forumEnv(dir))
      assert.equal(result.code, 0)
      assert.match(result.stderr, /^pi-forum: warning: skipping malformed record at byte offset \d+/)
      JSON.parse(result.stdout)
    }
    await fs.appendFile(logPath(dir), '{"partial')
    const result = await run(['message', 'post', topic.id, '--body', 'x'], forumEnv(dir))
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /pi-forum: error: .*incomplete record .*repair it manually/)
  })

  test('a held lock fails with a bounded error', async () => {
    const dir = await tempForum()
    await fs.mkdir(path.join(dir, '.write-lock'), { recursive: true })
    await fails(['topic', 'create', 'T'], forumEnv(dir), /timed out waiting for .*\.write-lock; .*remove it manually/)
    assert.equal(await readLog(dir), null)
  })

  test('a partial topic creation names the created topic and prints no result', async () => {
    const dir = await tempForum()
    const stderr = await fails(
      ['topic', 'create', 'Partial', '--body', 'lost'],
      { nodeArgs: ['--import', FAIL_MESSAGE_APPEND], ...forumEnv(dir) },
      /simulated failure/,
    )
    const [event] = (await readLog(dir))!.trim().split('\n').map((line): StoredEvent => JSON.parse(line))
    assert.equal(event!.type, 'topic_created')
    assert.match(stderr, new RegExp(`topic ${event!.id} was created, but its initial message may be missing`))
    assert.match(stderr, new RegExp(`pi-forum message list --topic ${event!.id}`))
    await ok(['topic', 'get', event!.id], forumEnv(dir))
  })
})

// main() in process with injected output streams and client factory: a recording wrapper around the
// shared API over an in-memory adapter, so nothing reaches the file system.
describe('dispatch through the shared API', () => {
  const FORUM_DIR = path.join(os.tmpdir(), 'pi-forum-cli-dispatch-never-created')

  // The client's methods, and one call a method received with its arguments.
  type Method = { [K in keyof Forum]: Forum[K] extends (...args: never[]) => unknown ? K : never }[keyof Forum]
  type Call = { [K in Method]: { name: K; args: Parameters<Forum[K]> } }[Method]

  function recordingFactory(adapter: FakeAdapter = fakeAdapter()) {
    const configs: CreateForumOptions[] = []
    const calls: Call[] = []
    const factory: ForumFactory = (config) => {
      configs.push(config)
      const client = createForum({ ...config, adapter })
      return new Proxy(client, {
        // The trap sees property names and values untyped; the functions it wraps are the client's
        // methods, so each call is recorded as a Call.
        get(target, name) {
          const value: unknown = Reflect.get(target, name)
          if (typeof value !== 'function') return value
          return (...args: unknown[]) => {
            calls.push({ name, args } as Call)
            return value(...args)
          }
        },
      })
    }
    return { adapter, factory, configs, calls }
  }

  // Runs main with captured output streams.
  async function invoke(argv: readonly string[], env: Environment, factory: ForumFactory) {
    const out: string[] = []
    const err: string[] = []
    const stream = (chunks: string[]) => ({ write: (chunk: string) => chunks.push(chunk) > 0 })
    const code = await main(argv, env, { createForum: factory, stdout: stream(out), stderr: stream(err) })
    return { code, stdout: out.join(''), stderr: err.join('') }
  }

  test('each command binds one client with the CLI configuration and calls its public method', async () => {
    const recording = recordingFactory()
    const env = { PI_FORUM_DIR: FORUM_DIR, PI_SESSION_ID: 'sess' }
    // Runs one command and returns its JSON result and the client calls it made.
    const command = async <G extends keyof Responses, V extends keyof Responses[G] & string>(
      argv: CommandArgs<G, V>,
    ): Promise<{ json: Responses[G][V]; calls: unknown[][] }> => {
      const configs = recording.configs.length
      const calls = recording.calls.length
      const result = await invoke(argv, env, recording.factory)
      assert.equal(result.stderr, '', argv.join(' '))
      assert.equal(result.code, 0)
      assert.deepEqual(recording.configs.slice(configs), [{ forumDir: FORUM_DIR, createOnRead: true }])
      // Every call passes the CLI's warning reporter in its final options; the rest is compared exactly.
      const made = recording.calls.slice(calls).map(({ name, args }) => {
        // Every client method takes its options last.
        const { onWarning, ...options } = args.at(-1) as ReadCallOptions | WriteCallOptions
        assert.equal(typeof onWarning, 'function')
        return [name, ...args.slice(0, -1), options]
      })
      return { json: JSON.parse(result.stdout), calls: made }
    }

    const created = await command(['topic', 'create', 'T', '--body', '  b  '])
    const { topic, message } = created.json
    assert.deepEqual(created.calls, [
      ['createTopic', { title: 'T', body: '  b  ', author: 'sess', originSessionId: 'sess' }, {}],
    ])
    assert.equal(message!.topic_id, topic.id)

    const topics = await command(['topic', 'list', '--limit', '5'])
    assert.deepEqual(topics.json.items, [topic])
    assert.match(topics.json.next_cursor, /^fake-/)
    assert.deepEqual(topics.calls, [['listTopics', { after: undefined, limit: 5 }]])

    const gotTopic = await command(['topic', 'get', topic.id])
    assert.deepEqual(gotTopic.json, { topic })
    assert.deepEqual(gotTopic.calls, [['getTopic', topic.id, {}]])

    const posted = await command(['message', 'post', topic.id, '--body', 'r', '--reply-to', message!.id, '--author', 'bot'])
    assert.deepEqual(posted.calls, [
      ['postMessage', { topicId: topic.id, body: 'r', replyTo: message!.id, author: 'bot', originSessionId: 'sess' }, {}],
    ])
    assert.equal(posted.json.message.reply_to, message!.id)

    const listed = await command(['message', 'list', '--topic', topic.id, '--after', topics.json.next_cursor])
    // The topic list's cursor is past the initial message, so only the later post follows it.
    assert.deepEqual(listed.json.items, [posted.json.message])
    assert.deepEqual(listed.calls, [
      ['listMessages', { topicId: topic.id, after: topics.json.next_cursor, limit: undefined }],
    ])

    const got = await command(['message', 'get', posted.json.message.id])
    assert.deepEqual(got.json, { message: posted.json.message })
    assert.deepEqual(got.calls, [['getMessage', posted.json.message.id, {}]])

    assert.deepEqual(
      recording.calls.map((call) => call.name),
      ['createTopic', 'listTopics', 'getTopic', 'postMessage', 'listMessages', 'getMessage'],
    )
    await assert.rejects(fs.stat(FORUM_DIR), { code: 'ENOENT' })
  })

  test('help, usage errors and an invalid binding never bind a client', async () => {
    const recording = recordingFactory()
    const env = { PI_FORUM_DIR: FORUM_DIR }
    for (const argv of [['--help'], ['message', 'get', '-h'], ['message', 'get', 'x', '--help']]) {
      const result = await invoke(argv, env, recording.factory)
      assert.equal(result.code, 0)
      assert.match(result.stdout, /^Usage:\n/)
    }
    for (const [argv, argEnv] of [
      [['message', 'get'], env],
      [['message', 'get', 'a', 'b'], env],
      [['message', 'get', 'x'], {}],
      [['message', 'get', 'x'], { PI_FORUM_DIR: 'relative' }],
    ] as const) {
      const result = await invoke(argv, argEnv, recording.factory)
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /^pi-forum: error: /)
    }
    assert.deepEqual(recording.configs, [])
  })

  test('warnings go to the injected stderr and results to the injected stdout', async () => {
    const forumDir = await tempForum()
    await fs.mkdir(forumDir)
    await fs.writeFile(logPath(forumDir), 'not json\n')
    const { topic } = await createTopic(forumDir, { title: 'T', author: 'a' })
    const result = await invoke(['topic', 'get', topic.id], { PI_FORUM_DIR: forumDir }, createForum)
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), { topic })
    assert.match(result.stderr, /^pi-forum: warning: skipping malformed record at byte offset 0: .*\n$/)
  })

  test('client errors keep their messages and recovery advice', async () => {
    const recording = recordingFactory()
    const env = { PI_FORUM_DIR: FORUM_DIR }
    const missing = await invoke(['message', 'get', 'nope'], env, recording.factory)
    assert.deepEqual(missing, { code: 1, stdout: '', stderr: 'pi-forum: error: message nope not found\n' })

    recording.adapter.failAppends((event) => event.type === 'message_posted')
    const partial = await invoke(['topic', 'create', 'Partial', '--body', 'lost'], env, recording.factory)
    recording.adapter.failAppends(() => false)
    assert.equal(partial.code, 1)
    assert.equal(partial.stdout, '')
    const [forum] = recording.adapter.forums.values()
    const id = forum!.events[0]!.data.id
    assert.equal(
      partial.stderr,
      `pi-forum: error: topic ${id} was created, but its initial message may be missing (fake append failed).\n` +
        `Check with "pi-forum message list --topic ${id}" and, if needed, post the body with ` +
        `"pi-forum message post ${id} ..." instead of creating the topic again.\n`,
    )
  })

  test('a partial write reads its cause once', async () => {
    let reads = 0
    const thrown = {
      code: 'PARTIAL_WRITE',
      topic: { id: 'T1' },
      message: 'outer',
      // A cause that is there only on its first read.
      get cause() {
        reads++
        return reads === 1 ? new Error('inner') : undefined
      },
    }
    const factory = () => {
      throw thrown
    }
    const result = await invoke(['topic', 'list'], { PI_FORUM_DIR: FORUM_DIR }, factory)
    assert.equal(reads, 1)
    assert.deepEqual(result, {
      code: 1,
      stdout: '',
      stderr:
        'pi-forum: error: topic T1 was created, but its initial message may be missing (inner).\n' +
        'Check with "pi-forum message list --topic T1" and, if needed, post the body with ' +
        '"pi-forum message post T1 ..." instead of creating the topic again.\n',
    })
  })
})
