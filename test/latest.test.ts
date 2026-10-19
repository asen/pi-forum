import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { TestContext } from 'node:test'
import { createForum } from '../src/forum.mjs'
import type { Message, SearchHit, Topic } from '../src/types.d.mts'
import { fakeAdapter } from './fake-adapter.ts'

for (const backend of ['jsonl', 'fake']) {
  describe(`latest-N and snapshot termination: ${backend}`, () => {
    async function fixture(t: TestContext) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-latest-'))
      t.after(() => fs.rm(root, { recursive: true, force: true }))
      return createForum({ forumDir: root, ...(backend === 'fake' ? { adapter: fakeAdapter() } : {}) })
    }

    test('latest topics, messages and search use append order, count omissions and resume future updates', async (t) => {
      const forum = await fixture(t)
      const topics: Topic[] = []
      const messages: Message[] = []
      const hits: SearchHit[] = []
      for (let i = 0; i < 25; i++) {
        const { topic, message } = await forum.createTopic({ title: `needle ${i}`, author: 'a', body: `needle body ${i}` })
        assert.ok(message)
        topics.push(topic)
        messages.push(message)
        hits.push({ type: 'topic', topic }, { type: 'message', message })
      }
      for (const limit of [1, 3, 25, 100]) {
        const tPage = await forum.listTopics({ latest: true, limit })
        const mPage = await forum.listMessages({ latest: true, limit })
        const sPage = await forum.search('needle', { latest: true, limit })
        assert.deepEqual(tPage.items, topics.slice(-limit))
        assert.deepEqual(mPage.items, messages.slice(-limit))
        assert.deepEqual(sPage.items, hits.slice(-limit))
        for (const [page, total] of [[tPage, 25], [mPage, 25], [sPage, 50]] as const) {
          assert.equal(page.has_more, false)
          assert.equal(page.older_omitted, Math.max(0, total - limit))
          assert.ok(page.next_cursor)
          assert.deepEqual((await forum.search('NOT absent', { after: page.next_cursor })).items, [])
        }
      }
      const latest = await forum.search('needle', { latest: true, limit: 1 })
      const { topic, message } = await forum.createTopic({ title: 'needle later', author: 'b', body: 'needle later body' })
      const updates = await forum.search('needle', { after: latest.next_cursor })
      assert.deepEqual(updates.items, [{ type: 'topic', topic }, { type: 'message', message }])
      assert.equal(updates.has_more, false)
      assert.equal(updates.older_omitted, undefined)
    })

    test('latest filters before selecting the window; empty and unknown scopes have no omissions', async (t) => {
      const forum = await fixture(t)
      const { topic: a } = await forum.createTopic({ title: 'needle A', author: 'a' })
      const { topic: b } = await forum.createTopic({ title: 'needle B', author: 'b' })
      const own: Message[] = []
      for (let i = 0; i < 5; i++) {
        own.push(await forum.postMessage({ topicId: a.id, author: 'a', body: `needle ${i}` }))
        await forum.postMessage({ topicId: b.id, author: 'b', body: 'needle unrelated' })
      }
      const messages = await forum.listMessages({ topicId: a.id, latest: true, limit: 2 })
      assert.deepEqual(messages.items, own.slice(-2))
      assert.equal(messages.older_omitted, 3)
      const search = await forum.search('needle', { topicId: a.id, latest: true, limit: 5 })
      assert.deepEqual(search.items, own.map((message) => ({ type: 'message', message })))
      assert.equal(search.older_omitted, 1, 'matching topic title is included in the count')
      for (const page of [
        await forum.listMessages({ topicId: 'missing', latest: true }),
        await forum.search('absent', { latest: true }),
        await forum.search('needle', { topicId: 'missing', latest: true }),
      ]) {
        assert.deepEqual(page.items, [])
        assert.equal(page.has_more, false)
        assert.equal(page.older_omitted, 0)
      }
    })

    test('lookahead leaves the next matching event unconsumed and exactly full final pages stop', async (t) => {
      const forum = await fixture(t)
      const { topic } = await forum.createTopic({ title: 'T', author: 'a' })
      const first = await forum.postMessage({ topicId: topic.id, author: 'a', body: 'needle first' })
      await forum.postMessage({ topicId: topic.id, author: 'a', body: 'unrelated gap' })
      const second = await forum.postMessage({ topicId: topic.id, author: 'a', body: 'needle second' })
      await forum.postMessage({ topicId: topic.id, author: 'a', body: 'unrelated tail' })
      const one = await forum.search('needle', { limit: 1 })
      assert.deepEqual(one.items, [{ type: 'message', message: first }])
      assert.equal(one.has_more, true)
      const two = await forum.search('needle', { limit: 1, after: one.next_cursor })
      assert.deepEqual(two.items, [{ type: 'message', message: second }])
      assert.equal(two.has_more, false)
      assert.deepEqual((await forum.listMessages({ after: two.next_cursor })).items, [])
      const later = await forum.postMessage({ topicId: topic.id, author: 'a', body: 'needle third' })
      const resumed = await forum.search('needle', { after: two.next_cursor, limit: 1 })
      assert.deepEqual(resumed.items, [{ type: 'message', message: later }])
      assert.equal(resumed.has_more, false)
    })

    test('latest rejects cursor combinations and invalid booleans; cancellation returns no partial window', async (t) => {
      const forum = await fixture(t)
      await forum.createTopic({ title: 'T', author: 'a', body: 'b' })
      const { next_cursor } = await forum.listTopics()
      await assert.rejects(forum.listTopics({ latest: true, after: next_cursor }), { code: 'INVALID_INPUT' })
      await assert.rejects(forum.listMessages({ latest: true, after: next_cursor }), { code: 'INVALID_INPUT' })
      await assert.rejects(forum.search('b', { latest: true, after: next_cursor }), { code: 'INVALID_INPUT' })
      // @ts-expect-error -- exercises runtime validation of an untyped caller
      await assert.rejects(forum.listTopics({ latest: 'yes' }), { code: 'INVALID_INPUT' })
      const signal = AbortSignal.abort()
      await assert.rejects(forum.listMessages({ latest: true, signal }), { code: 'ABORTED' })
      await assert.rejects(forum.search('b', { latest: true, signal }), { code: 'ABORTED' })
    })
  })
}
