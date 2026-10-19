import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { main } from '../src/cli.mjs'
import { createForum } from '../src/forum.mjs'
import type { Message, Page, SearchHit } from '../src/types.d.mts'

type Preview = Message & { body_bytes: number; body_truncated: boolean }
type Chunk = { message: Message; body_bytes: number; offset: number; next_offset: number | null }
type Receipt = { topic_id: string; message_id: string | null }

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-agent-output-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const dir = path.join(root, 'forum')
  const forum = createForum({ forumDir: dir })
  async function run(args: string[]) {
    let stdout = ''
    let stderr = ''
    const code = await main(args, { PI_FORUM_DIR: dir }, {
      stdout: { write(text) { stdout += text } },
      stderr: { write(text) { stderr += text } },
    })
    return { code, stdout, stderr }
  }
  async function ok<T>(args: string[], maxBytes = 30000): Promise<T> {
    const result = await run(args)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.ok(Buffer.byteLength(result.stdout) <= maxBytes, 'stdout includes framing and newline in its budget')
    assert.equal(result.stdout.indexOf('\n'), result.stdout.length - 1, 'exactly one JSON line')
    // The only unchecked boundary: subsequent assertions check the parsed response.
    return JSON.parse(result.stdout) as T
  }
  return { dir, forum, run, ok }
}

describe('agent-first CLI output', () => {
  test('writes return bounded receipts, not an echo of the body; storage remains complete', async (t) => {
    const { forum, ok, run } = await fixture(t)
    const body = 'x'.repeat(65536)
    const created = await ok<Receipt>(['topic', 'create', 'T', '--body', body, '--max-bytes', '2048'], 2048)
    assert.deepEqual(Object.keys(created), ['topic_id', 'message_id'])
    assert.ok(created.message_id)
    assert.equal((await forum.getMessage(created.message_id)).body, body)
    const posted = await ok<Receipt>(['message', 'post', created.topic_id, '--body', body, '--max-bytes', '2048'], 2048)
    assert.equal(posted.topic_id, created.topic_id)
    assert.ok(posted.message_id)
    assert.equal((await forum.getMessage(posted.message_id)).body, body)
    const full = await run(['message', 'get', posted.message_id, '--full'])
    assert.equal(full.code, 0)
    assert.ok(Buffer.byteLength(full.stdout) > 51200)
    assert.deepEqual(JSON.parse(full.stdout), { message: await forum.getMessage(posted.message_id) })
  })

  test('even the longest accepted escaped topic ID fits a minimum-budget write receipt', async (t) => {
    const { dir, forum, ok } = await fixture(t)
    const id = '\u0001'.repeat(256)
    await fs.mkdir(dir)
    await fs.writeFile(path.join(dir, 'events.jsonl'), JSON.stringify({
      type: 'topic_created', id, title: 'Imported', created_by: 'a', created_at: 'now',
    }) + '\n')
    const receipt = await ok<Receipt>(['message', 'post', id, '--author', '😀'.repeat(128), '--body', 'saved', '--max-bytes', '2048'], 2048)
    assert.equal(receipt.topic_id, id)
    assert.ok(receipt.message_id)
    assert.equal((await forum.getMessage(receipt.message_id)).body, 'saved')
  })

  test('large list/search pages shrink previews without dropping records or changing cursors', async (t) => {
    const { forum, ok, run } = await fixture(t)
    const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
    const body = 'probe ' + '😀\u0000"\\\n'.repeat(1000)
    for (let i = 0; i < 55; i++) await forum.postMessage({ topicId: topic.id, author: 'a', body: `${i} ${body}` })
    for (const command of [['message', 'list'], ['search', 'probe']]) {
      const args = [...command, '--limit', '50']
      const bounded = await ok<Page<Preview | { type: 'message'; message: Preview }>>(args)
      const full = await run([...args, '--full'])
      assert.equal(full.code, 0)
      assert.ok(Buffer.byteLength(full.stdout) > 51200)
      const original: Page<Message | SearchHit> = JSON.parse(full.stdout)
      assert.equal(bounded.items.length, 50)
      assert.equal(bounded.next_cursor, original.next_cursor)
      assert.equal(bounded.has_more, true)
      const messages = bounded.items.map((item) => 'message' in item ? item.message : item)
      assert.ok(messages.every((m) => m.body_truncated && [...m.body].length < 512))
      for (const message of messages) {
        const stored = await forum.getMessage(message.id)
        assert.equal(message.body_bytes, Buffer.byteLength(stored.body))
        assert.ok(stored.body.startsWith(message.body))
        assert.ok(message.body.isWellFormed())
      }
      const rest = await ok<Page<unknown>>([...command, '--after', bounded.next_cursor])
      assert.equal(rest.items.length, 5)
      assert.equal(rest.has_more, false)
    }
    const short = await forum.postMessage({ topicId: topic.id, author: 'a', body: 'short' })
    const latest = await ok<Page<Preview>>(['message', 'list', '--latest', '--limit', '1'])
    assert.deepEqual(latest.items, [{ ...short, body_bytes: 5, body_truncated: false }])
    assert.equal(latest.older_omitted, 55)
    assert.equal(latest.has_more, false)
  })

  test('metadata overflow is an explicit error, not clipped JSON or silent page loss', async (t) => {
    const { forum, run, ok } = await fixture(t)
    for (let i = 0; i < 20; i++) {
      await forum.createTopic({ title: `${i}${'\u0001'.repeat(250)}`, author: '\u0002'.repeat(256) })
    }
    const failed = await run(['topic', 'list'])
    assert.equal(failed.code, 1)
    assert.equal(failed.stdout, '')
    assert.match(failed.stderr, /metadata alone exceeds --max-bytes; reduce --limit/)
    const smaller = await ok<Page<unknown>>(['topic', 'list', '--limit', '1'])
    assert.equal(smaller.items.length, 1)
    assert.equal(smaller.has_more, true)
  })

  test('chunk offsets reconstruct Unicode and escaped bodies exactly, including the final boundary', async (t) => {
    const { forum, ok, run } = await fixture(t)
    const body = '😀\\\n"\u0000a'.repeat(7000)
    const { message } = await forum.createTopic({ title: 'T', author: 'a', body })
    assert.ok(message)
    const first = await ok<Chunk>(['message', 'get', message.id])
    assert.ok(first.next_offset !== null)
    let offset = 0
    let reconstructed = ''
    let count = 0
    for (;;) {
      const chunk: Chunk = await ok<Chunk>(['message', 'get', message.id, '--offset', String(offset), '--max-bytes', '2048'], 2048)
      assert.equal(chunk.offset, offset)
      assert.equal(chunk.message.id, message.id)
      assert.equal(chunk.body_bytes, Buffer.byteLength(body))
      assert.ok(chunk.message.body.isWellFormed())
      reconstructed += chunk.message.body
      const end = offset + [...chunk.message.body].length
      count++
      assert.ok(count < 200, 'each read must make progress')
      if (chunk.next_offset === null) {
        assert.equal(end, [...body].length)
        break
      }
      assert.equal(chunk.next_offset, end)
      assert.ok(end > offset)
      offset = end
    }
    assert.ok(count > 1)
    assert.equal(reconstructed, body)
    const end = await ok<Chunk>(['message', 'get', message.id, '--offset', String([...body].length)])
    assert.equal(end.message.body, '')
    assert.equal(end.next_offset, null)
    const past = await run(['message', 'get', message.id, '--offset', String([...body].length + 1)])
    assert.equal(past.code, 1)
    assert.equal(past.stdout, '')
    assert.match(past.stderr, /past the end/)
  })

  test('latest scoped discovery resumes future appends with an ordinary cursor', async (t) => {
    const { forum, ok } = await fixture(t)
    const { topic: a } = await forum.createTopic({ title: 'T', author: 'a' })
    const { topic: b } = await forum.createTopic({ title: 'Other', author: 'b' })
    const messages: Message[] = []
    for (let i = 0; i < 7; i++) {
      messages.push(await forum.postMessage({ topicId: a.id, author: 'a', body: `needle ${i}` }))
      await forum.postMessage({ topicId: b.id, author: 'b', body: 'needle observer' })
    }
    const latest = await ok<Page<{ type: 'message'; message: Preview }>>(['search', 'needle', '--topic', a.id, '--latest', '--limit', '3'])
    assert.deepEqual(latest.items.map((h) => h.message.id), messages.slice(-3).map((m) => m.id))
    assert.equal(latest.older_omitted, 4)
    assert.equal(latest.has_more, false)
    const later = await forum.postMessage({ topicId: a.id, author: 'a', body: 'needle later' })
    const updates = await ok<Page<Preview>>(['message', 'list', '--topic', a.id, '--after', latest.next_cursor])
    assert.deepEqual(updates.items.map((m) => m.id), [later.id])
    assert.equal(updates.has_more, false)
  })

  test('new options reject invalid or conflicting input before binding storage', async () => {
    for (const args of [
      ['message', 'get', 'm', '--offset=-1'],
      ['message', 'get', 'm', '--offset=1.5'],
      ['message', 'get', 'm', '--offset=9007199254740992'],
      ['message', 'list', '--offset=0'],
      ['message', 'get', 'm', '--full', '--offset=0'],
      ['topic', 'create', 'T', '--full', '--max-bytes=30000'],
      ['topic', 'list', '--max-bytes=2047'],
      ['topic', 'list', '--max-bytes=1e4'],
      ['topic', 'list', '--max-bytes=2048', '--max-bytes=4096'],
      ['search', 'x', '--latest', '--after=c'],
      ['message', 'list', '--after=c', '--latest'],
      ['topic', 'list', '--latest', '--latest'],
      ['topic', 'list', '--latest=yes'],
    ]) {
      let stdout = ''
      const code = await main(args, { PI_FORUM_DIR: '/unused' }, {
        createForum: () => assert.fail('invalid options must not bind storage'),
        stdout: { write(text) { stdout += text } },
        stderr: { write() {} },
      })
      assert.equal(code, 1, args.join(' '))
      assert.equal(stdout, '')
    }
  })
})
