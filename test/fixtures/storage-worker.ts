// One writer process of storage.test.ts's concurrent-process test, run as
// `node storage-worker.ts <forumDir> <topicId> <worker>`. It posts ten messages to the topic and creates
// two topics with initial messages, all labelled with the worker's name.
import { createTopic, postMessage } from '../../src/storage.js'

const [dir, topicId, worker] = process.argv.slice(2)
if (dir === undefined || topicId === undefined || worker === undefined) {
  throw new Error('usage: storage-worker.ts <forumDir> <topicId> <worker>')
}
for (let i = 0; i < 10; i++) {
  await postMessage(dir, { topicId, author: worker, body: worker + ':' + i + ' ' + '🧵'.repeat(500) })
  if (i % 5 === 0) await createTopic(dir, { title: worker + ':' + i, author: worker, body: 'é'.repeat(1000) })
}
