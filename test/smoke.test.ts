// End-to-end CLI workflow in a temp directory, run with `npm run smoke`: two callers share one
// forum through the bundled executable, page through it with cursors, pick up a later append,
// search it with shell-quoted queries, and leave nothing behind outside the forum directory, which
// is removed at the end.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Environment } from '../src/cli.mjs'
import type { CreateTopicResult, Message, Page, SearchHit, Topic } from '../src/types.d.mts'

const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))
const NODE_DIR = path.dirname(process.execPath)

interface PiForumOptions {
  env: Environment
  cwd: string
  input?: string | undefined
}

interface PiForumResult {
  code: number | null
  stdout: string
  stderr: string
}

// What each command prints on success, by its two command words, as the help documents.
interface Responses {
  topic: { create: CreateTopicResult; get: { topic: Topic }; list: Page<Topic> }
  message: { post: { message: Message }; get: { message: Message }; list: Page<Message> }
}

// Runs pi-forum through PATH with only the given environment, as Pi's bash would. Given a string,
// runs it as a shell command line, so the shell does the quoting.
function piForum(args: readonly string[] | string, { env, cwd, input }: PiForumOptions): Promise<PiForumResult> {
  return new Promise((resolve, reject) => {
    const child = typeof args === 'string' ? spawn('/bin/sh', ['-c', args], { env, cwd }) : spawn('pi-forum', args, { env, cwd })
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

test('a shared forum workflow through the bundled executable', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-smoke-')))
  try {
    const home = path.join(root, 'home')
    const work = path.join(root, 'work')
    const forumDir = path.join(root, 'forum')
    await fs.mkdir(home)
    await fs.mkdir(work)
    const base = { PATH: [BIN_DIR, NODE_DIR, '/usr/bin', '/bin'].join(path.delimiter), HOME: home, PI_FORUM_DIR: forumDir }
    const main = { ...base, PI_SESSION_ID: 'main-session' }
    const helper = { ...base }

    // Runs a command expected to succeed. Parsing its output as the command's documented response is
    // the only unchecked step; the workflow asserts the fields it uses.
    const ok = async <G extends keyof Responses, V extends keyof Responses[G] & string>(
      args: readonly [G, V, ...string[]],
      env: Environment,
      input?: string,
    ): Promise<Responses[G][V]> => {
      const result = await piForum(args, { env, cwd: work, input })
      assert.equal(result.stderr, '', `stderr of ${args.join(' ')}`)
      assert.equal(result.code, 0)
      return JSON.parse(result.stdout)
    }

    // Runs a search command line through the shell, expecting its page of hits.
    const search = async (commandLine: string, env: Environment): Promise<Page<SearchHit>> => {
      const result = await piForum(commandLine, { env, cwd: work })
      assert.equal(result.stderr, '', `stderr of ${commandLine}`)
      assert.equal(result.code, 0)
      return JSON.parse(result.stdout)
    }
    const text = (hit: SearchHit) => (hit.type === 'topic' ? hit.topic.title : hit.message.body)

    // The main session opens a topic with an initial message.
    const created = await ok(['topic', 'create', 'Flaky tests', '--body', 'Report findings here.'], main)
    const topicId = created.topic.id
    assert.equal(created.topic.created_by, 'main-session')
    assert.equal(created.topic.origin_session_id, 'main-session')
    assert.equal(created.message!.body, 'Report findings here.')
    assert.deepEqual((await ok(['topic', 'get', topicId], main)).topic, created.topic)

    // A caller without Pi metadata posts with a label, from a file and from stdin.
    await fs.writeFile(path.join(work, 'finding.md'), 'Timeout in `db.test.js`:\n\n  $ npm test -- --grep "pool"\n')
    const fromFile = await ok(['message', 'post', topicId, '--body-file', 'finding.md', '--author', 'helper'], helper)
    assert.equal(fromFile.message.body, 'Timeout in `db.test.js`:\n\n  $ npm test -- --grep "pool"\n')
    assert.equal(fromFile.message.author, 'helper')
    assert.equal(fromFile.message.origin_session_id, undefined)
    const fromStdin = await ok(['message', 'post', topicId, '--body-stdin'], helper, 'It\'s the "pool" size.\n')
    assert.equal(fromStdin.message.author, 'external')
    const reply = await ok(['message', 'post', topicId, '--body', 'Confirmed.', '--reply-to', fromFile.message.id], main)
    assert.equal(reply.message.reply_to, fromFile.message.id)
    // The replied-to message can be read back whole by its ID.
    assert.deepEqual(await ok(['message', 'get', reply.message.reply_to], main), fromFile)

    // A second topic, then paging through all messages two at a time.
    const other = await ok(['topic', 'create', 'Release notes'], helper)
    assert.equal(other.message, null)
    const topics = await ok(['topic', 'list'], main)
    assert.deepEqual(topics.items.map((t) => t.title), ['Flaky tests', 'Release notes'])

    const bodies: string[] = []
    let cursor: string | undefined
    let pages = 0
    for (;;) {
      const page = await ok(['message', 'list', '--limit', '2', ...(cursor ? ['--after', cursor] : [])], main)
      cursor = page.next_cursor
      if (page.items.length === 0) break
      bodies.push(...page.items.map((m) => m.body))
      pages++
    }
    assert.equal(pages, 2)
    assert.deepEqual(bodies, ['Report findings here.', fromFile.message.body, fromStdin.message.body, 'Confirmed.'])

    // A later append shows up after the caught-up cursor, and only it.
    const fixed = await ok(['message', 'post', topicId, '--body', 'Fixed in the pool config.'], helper)
    const later = await ok(['message', 'list', '--topic', topicId, '--after', cursor], main)
    assert.deepEqual(later.items.map((m) => m.body), ['Fixed in the pool config.'])
    assert.deepEqual((await ok(['message', 'list', '--after', later.next_cursor], main)).items, [])

    // Searches quoted as a shell user would: phrases and groups reach the query intact, and each
    // topic title or message body matches on its own.
    const found = await search(`pi-forum search '"flaky tests" OR ("pool" AND (timeout OR config)) NOT size' --limit 20`, main)
    assert.deepEqual(found.items, [
      { type: 'topic', topic: created.topic },
      { type: 'message', message: fromFile.message },
      { type: 'message', message: fixed.message },
    ])
    // A phrase with escaped quotes, paged one hit at a time.
    const quoted: SearchHit[] = []
    let after = ''
    for (;;) {
      const page = await search(`pi-forum search '"\\"pool\\""' --limit 1 ${after}`, helper)
      if (page.items.length === 0) break
      quoted.push(...page.items)
      after = `--after ${page.next_cursor}`
    }
    assert.deepEqual(quoted.map(text), [fromFile.message.body, fromStdin.message.body])
    // A dash-leading query follows the options and --.
    assert.deepEqual((await search(`pi-forum search --limit 5 -- --grep`, main)).items.map(text), [fromFile.message.body])
    assert.deepEqual((await search(`pi-forum search 'nothing AND "like this"'`, main)).items, [])
    const malformed = await piForum(`pi-forum search '(flaky'`, { env: main, cwd: work })
    assert.deepEqual(malformed, { code: 1, stdout: '', stderr: 'pi-forum: error: search query has an unclosed "(" at offset 0\n' })

    // An unknown topic lists as empty; getting it or an unknown message fails on stderr.
    assert.deepEqual((await ok(['message', 'list', '--topic', 'no-such-topic'], main)).items, [])
    const missing = await piForum(['topic', 'get', 'no-such-topic'], { env: main, cwd: work })
    assert.equal(missing.code, 1)
    assert.equal(missing.stdout, '')
    assert.match(missing.stderr, /^pi-forum: error: topic no-such-topic not found\n$/)
    const missingMessage = await piForum(['message', 'get', 'no-such-message'], { env: main, cwd: work })
    assert.equal(missingMessage.code, 1)
    assert.equal(missingMessage.stdout, '')
    assert.equal(missingMessage.stderr, 'pi-forum: error: message no-such-message not found\n')

    // Only the log was written: no lock left behind, nothing in HOME or the working directory.
    assert.deepEqual(await fs.readdir(forumDir), ['events.jsonl'])
    const log = await fs.readFile(path.join(forumDir, 'events.jsonl'), 'utf8')
    assert.equal(log.trim().split('\n').length, 7)
    assert.deepEqual(await fs.readdir(home), [])
    assert.deepEqual(await fs.readdir(work), ['finding.md'])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
  await assert.rejects(fs.access(root), { code: 'ENOENT' })
})
