import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { fileURLToPath } from 'node:url'
import { createForumRuntime } from './runtime.js'

// The bundled executable's directory, wherever the package is installed.
const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))

export default function piForum(pi) {
  const runtime = createForumRuntime({ binDir: BIN_DIR, getAgentDir })
  pi.on('session_start', (_event, ctx) => runtime.sessionStart(ctx))
  pi.on('before_agent_start', (event, ctx) => runtime.beforeAgentStart(event, ctx))
  pi.on('session_shutdown', () => runtime.sessionShutdown())
}
