// A probe extension for a pi subprocess in pi-integration.test.ts, loaded after pi-forum: appends what
// each session start and shutdown sees to the log its JSON sidecar names (X.ts reads X.json), one
// JSON line each, including whether Pi trusts the project.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from '@earendil-works/pi-coding-agent'

export interface StartupProbeConfig {
  log: string
}

// One line of the log. trusted is the error as text if Pi could not say.
export interface StartupProbeRecord {
  type: (SessionStartEvent | SessionShutdownEvent)['type']
  reason: (SessionStartEvent | SessionShutdownEvent)['reason']
  cwd: string
  trusted: boolean | string
  sessionId: string
  forumDir: string | null
  PATH: string | undefined
}

// The test wrote the sidecar from a StartupProbeConfig.
const { log } = JSON.parse(fs.readFileSync(fileURLToPath(import.meta.url).replace(/\.ts$/, '.json'), 'utf8')) as StartupProbeConfig

export default function (pi: ExtensionAPI) {
  const record = (event: SessionStartEvent | SessionShutdownEvent, ctx: ExtensionContext) => {
    let trusted
    try {
      trusted = ctx.isProjectTrusted()
    } catch (err) {
      trusted = String(err)
    }
    const line: StartupProbeRecord = {
      type: event.type,
      reason: event.reason,
      cwd: ctx.cwd,
      trusted,
      sessionId: ctx.sessionManager.getSessionId(),
      forumDir: process.env.PI_FORUM_DIR ?? null,
      PATH: process.env.PATH,
    }
    fs.appendFileSync(log, JSON.stringify(line) + '\n')
  }
  pi.on('session_start', record)
  pi.on('session_shutdown', record)
}
