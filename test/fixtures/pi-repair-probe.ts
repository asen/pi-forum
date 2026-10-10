// A probe extension for a pi subprocess in pi-integration.test.ts, loaded after pi-forum and
// configured by its JSON sidecar (X.ts reads X.json). At session start, once marker exists, it
// removes marker and the file at forums, so pi-forum's own startup activation has already failed on
// that file and the same runtime can then select again. /probe-env appends a RepairProbeRecord to
// log: whether forums exists, and the entries of this session's generated directory, or null while
// it does not exist.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export interface RepairProbeConfig {
  log: string
  marker: string
  forums: string
}

export interface RepairProbeRecord {
  type: 'probe-env'
  forumDir: string | null
  PATH: string | undefined
  forums: boolean
  entries: string[] | null
}

// The test wrote the sidecar from a RepairProbeConfig.
const { log, marker, forums } = JSON.parse(fs.readFileSync(fileURLToPath(import.meta.url).replace(/\.ts$/, '.json'), 'utf8')) as RepairProbeConfig

export default function (pi: ExtensionAPI) {
  pi.on('session_start', () => {
    if (!fs.existsSync(marker)) return
    fs.rmSync(marker)
    fs.rmSync(forums)
  })
  pi.registerCommand('probe-env', {
    description: 'Record the environment for the test',
    handler: async (_args, ctx) => {
      const dir = process.env.PI_FORUM_DIR ?? path.join(forums, 'sessions', ctx.sessionManager.getSessionId())
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : null
      const record: RepairProbeRecord = { type: 'probe-env', forumDir: process.env.PI_FORUM_DIR ?? null, PATH: process.env.PATH, forums: fs.existsSync(forums), entries }
      fs.appendFileSync(log, JSON.stringify(record) + '\n')
    },
  })
}
