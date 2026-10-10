// The synthetic provider for a Pi subprocess, installed into a scratch directory and driven through
// files in PI_FORUM_SYNTHETIC_DIR: each delta-N file is streamed in order, and a finish file ends
// the response. Requests, deltas, aborts and the agent's own message updates are appended to
// log.jsonl there.
import fs from 'node:fs'
import path from 'node:path'
import { createAssistantMessageEventStream, type AssistantMessage, type TextContent } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

// Every Pi the tests start with this provider sets it.
const dir = process.env.PI_FORUM_SYNTHETIC_DIR!
const log = (entry: { event: string; call?: number; n?: number; delta?: string }) =>
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n')

export default function (pi: ExtensionAPI) {
  let calls = 0
  pi.registerProvider('forum-synthetic', {
    baseUrl: 'http://127.0.0.1:9/unused',
    apiKey: 'synthetic-key',
    api: 'forum-synthetic',
    models: [{ id: 'held', name: 'Held stream', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const call = ++calls
      log({ event: 'request', call })
      const stream = createAssistantMessageEventStream()
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      // The message's one content block, which the deltas extend.
      const text: TextContent = { type: 'text', text: '' }
      const message: AssistantMessage = { role: 'assistant', content: [text], api: model.api, provider: model.provider, model: model.id, usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }
      let sent = 0
      const timer = setInterval(() => {
        const next = path.join(dir, 'delta-' + (sent + 1))
        if (fs.existsSync(next)) {
          const delta = fs.readFileSync(next, 'utf8')
          sent++
          text.text += delta
          stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message })
          log({ event: 'delta', call, n: sent })
        } else if (fs.existsSync(path.join(dir, 'finish'))) {
          clearInterval(timer)
          stream.push({ type: 'text_end', contentIndex: 0, content: text.text, partial: message })
          stream.push({ type: 'done', reason: 'stop', message })
          stream.end()
          log({ event: 'done', call })
        }
      }, 20)
      options?.signal?.addEventListener('abort', () => {
        clearInterval(timer)
        log({ event: 'abort', call })
        message.stopReason = 'aborted'
        message.errorMessage = 'aborted'
        stream.push({ type: 'error', reason: 'aborted', error: message })
        stream.end()
      })
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'text_start', contentIndex: 0, partial: message })
      return stream
    },
  })
  pi.on('message_update', (event) => {
    if (event.assistantMessageEvent?.type === 'text_delta') log({ event: 'message_update', delta: event.assistantMessageEvent.delta })
  })
  pi.on('agent_end', () => log({ event: 'agent_end' }))
}
