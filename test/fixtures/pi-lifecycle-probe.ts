// A probe extension for pi-integration.test.ts's in-process Pi host, which loads one copy before
// pi-forum and one after it. Each copy records what session_start and session_shutdown see, the
// prompt before_agent_start renders and the extension context Pi passes, in globalThis.piForumProbe,
// which the test sets before Pi loads it. Its position comes from the JSON sidecar the test writes
// next to the copy (X.ts reads X.json).
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from '@earendil-works/pi-coding-agent'

export interface LifecycleProbeConfig {
  position: 'before' | 'after'
}

// One session_start or session_shutdown as a probe saw it.
export interface LifecycleEvent {
  probe: LifecycleProbeConfig['position']
  type: (SessionStartEvent | SessionShutdownEvent)['type']
  reason: (SessionStartEvent | SessionShutdownEvent)['reason']
  sessionId: string
  forumDir: string | undefined
  path: string | undefined
}

export interface LifecycleProbeState {
  events: LifecycleEvent[]
  // The prompt each probe's before_agent_start saw, the number of runs started, and the context of
  // the last one.
  prompts: Partial<Record<LifecycleProbeConfig['position'], string>>
  starts?: number
  ctx?: ExtensionContext
  // Setting it cancels the next /new, /resume or /fork, as an extension or the user can.
  cancel?: boolean
}

// The test wrote the sidecar from a LifecycleProbeConfig.
const { position } = JSON.parse(fs.readFileSync(fileURLToPath(import.meta.url).replace(/\.ts$/, '.json'), 'utf8')) as LifecycleProbeConfig

export default function (pi: ExtensionAPI) {
  // The test sets it before it loads Pi's extensions.
  const state = globalThis.piForumProbe!
  const record = (event: SessionStartEvent | SessionShutdownEvent, ctx: ExtensionContext) => {
    state.events.push({
      probe: position,
      type: event.type,
      reason: event.reason,
      sessionId: ctx.sessionManager.getSessionId(),
      forumDir: process.env.PI_FORUM_DIR,
      path: process.env.PATH,
    })
  }
  pi.on('session_start', record)
  pi.on('session_shutdown', record)
  pi.on('before_agent_start', (event, ctx) => {
    if (position === 'before') event.systemPromptOptions.sections.team_notes = 'Notes from another extension.'
    state.starts = (state.starts ?? 0) + 1
    state.prompts[position] = event.systemPrompt
    state.ctx = ctx
  })
  if (position === 'before') {
    pi.on('session_before_switch', () => (state.cancel ? { cancel: true } : undefined))
    pi.on('session_before_fork', () => (state.cancel ? { cancel: true } : undefined))
  }
}
