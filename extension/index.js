import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { fileURLToPath } from 'node:url'
import { COMMAND_NAME, createForumRuntime, forumCompletions } from './runtime.js'

// The bundled executable's directory, wherever the package is installed.
const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))

export default function piForum(pi) {
  const runtime = createForumRuntime({ binDir: BIN_DIR, getAgentDir })
  pi.on('session_start', (_event, ctx) => runtime.sessionStart(ctx))
  pi.on('before_agent_start', (event, ctx) => runtime.beforeAgentStart(event, ctx))
  pi.on('session_shutdown', () => runtime.sessionShutdown())
  pi.registerCommand(COMMAND_NAME, {
    description: 'Turn the pi-forum binding for this session on or off, or show its status',
    getArgumentCompletions: forumCompletions,
    handler: async (args, ctx) => runtime.command(args, ctx),
  })
}
