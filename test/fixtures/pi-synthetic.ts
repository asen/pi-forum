// Extension for an in-process synthetic provider, installed into a scratch directory and loaded by
// Pi like any provider extension; its agent loop streams from it. The test decides, through
// globalThis.piForumSynthetic (see installSyntheticProvider in pi-fixtures.ts), when each text delta
// arrives and when the response ends. It never touches the network.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerProvider('forum-synthetic', {
    baseUrl: 'http://127.0.0.1:9/unused',
    apiKey: 'synthetic-key',
    api: 'forum-synthetic',
    models: [{ id: 'held', name: 'Held stream', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    // Installed before any request reaches the provider.
    streamSimple: (model, context, options) => globalThis.piForumSynthetic!.stream(model, context, options),
  })
}
