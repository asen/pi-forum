// End-to-end CLI workflow in a temp directory, run with `npm run smoke`: two callers share one
// forum through the bundled executable, page through it with cursors, pick up a later append,
// and leave nothing behind outside the forum directory, which is removed at the end.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))
const NODE_DIR = path.dirname(process.execPath)

// Runs pi-forum through PATH with only the given environment, as Pi's bash would.
function piForum(args, { env, cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn('pi-forum', args, { env, cwd })
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
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

    const ok = async (args, env, input) => {
      const result = await piForum(args, { env, cwd: work, input })
      assert.equal(result.stderr, '', `stderr of ${args.join(' ')}`)
      assert.equal(result.code, 0)
      return JSON.parse(result.stdout)
    }

    // The main session opens a topic with an initial message.
    const created = await ok(['topic', 'create', 'Flaky tests', '--body', 'Report findings here.'], main)
    const topicId = created.topic.id
    assert.equal(created.topic.created_by, 'main-session')
    assert.equal(created.topic.origin_session_id, 'main-session')
    assert.equal(created.message.body, 'Report findings here.')
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

    const bodies = []
    let cursor
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
    await ok(['message', 'post', topicId, '--body', 'Fixed in the pool config.'], helper)
    const later = await ok(['message', 'list', '--topic', topicId, '--after', cursor], main)
    assert.deepEqual(later.items.map((m) => m.body), ['Fixed in the pool config.'])
    assert.deepEqual((await ok(['message', 'list', '--after', later.next_cursor], main)).items, [])

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
