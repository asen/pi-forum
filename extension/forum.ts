import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import * as tui from '@earendil-works/pi-tui'
import { fileURLToPath } from 'node:url'
import { createForum } from '../src/forum.mjs'
import { createBrowserOpener } from './browser.ts'
import { createEntryRenderer, ENTRY_TYPE, entryData } from './entry-renderer.ts'
import { createPreferenceStore } from './preferences.ts'
import { COMMAND_NAME, createForumRuntime, forumCompletions } from './runtime.ts'

// The bundled executable's directory, wherever the package is installed.
const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))

// The part of Pi's extension API the factory registers through.
export type ForumExtensionAPI = Pick<ExtensionAPI, 'on' | 'registerCommand' | 'registerEntryRenderer' | 'appendEntry'>

export default function piForum(pi: ForumExtensionAPI): void {
  const runtime = createForumRuntime({
    binDir: BIN_DIR,
    getAgentDir,
    createForum,
    openBrowser: createBrowserOpener(tui),
    // Every text result becomes one session entry, in every mode; entries never reach the model.
    onText: (text) => pi.appendEntry(ENTRY_TYPE, entryData(text)),
    visibleWidth: tui.visibleWidth,
    preferences: createPreferenceStore({ getAgentDir }),
  })
  pi.registerEntryRenderer(ENTRY_TYPE, createEntryRenderer(tui))
  pi.on('session_start', (_event, ctx) => runtime.sessionStart(ctx))
  pi.on('before_agent_start', (event, ctx) => runtime.beforeAgentStart(event, ctx))
  pi.on('session_shutdown', () => runtime.sessionShutdown())
  pi.registerCommand(COMMAND_NAME, {
    description:
      'Turn the pi-forum binding for this session on or off, save or reset whether new sessions start with it for this project or user ' +
      '(project on shares .pi/forum; user on only enables by default), ' +
      'show its status, read its topics and messages as text, or browse them with /forum ui',
    getArgumentCompletions: forumCompletions,
    handler: async (args, ctx) => runtime.command(args, ctx),
  })
}
