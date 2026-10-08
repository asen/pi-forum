import { getAgentDir } from '@earendil-works/pi-coding-agent'
import * as tui from '@earendil-works/pi-tui'
import { fileURLToPath } from 'node:url'
import { createForum } from '../src/forum.js'
import { createBrowserOpener } from './browser.js'
import { COMMAND_NAME, createForumRuntime, forumCompletions } from './runtime.js'

// The bundled executable's directory, wherever the package is installed.
const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))

export default function piForum(pi) {
  const runtime = createForumRuntime({ binDir: BIN_DIR, getAgentDir, createForum, openBrowser: createBrowserOpener(tui) })
  pi.on('session_start', (_event, ctx) => runtime.sessionStart(ctx))
  pi.on('before_agent_start', (event, ctx) => runtime.beforeAgentStart(event, ctx))
  pi.on('session_shutdown', () => runtime.sessionShutdown())
  pi.registerCommand(COMMAND_NAME, {
    description: 'Turn the pi-forum binding for this session on or off, show its status, or browse its topics and messages',
    getArgumentCompletions: forumCompletions,
    handler: async (args, ctx) => runtime.command(args, ctx),
  })
}
