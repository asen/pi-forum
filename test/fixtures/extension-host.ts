// Stands in for @earendil-works/pi-coding-agent when extension.test.ts loads the extension entry, which
// imports only getAgentDir from it at run time. The agent directory is the one the test set last.
import type * as pi from '@earendil-works/pi-coding-agent'

// Each entry test sets piForumTestAgentDir before it imports the entry, and the runtime reads the agent
// directory only on activation, so it is set whenever this is called.
export const getAgentDir: typeof pi.getAgentDir = () => globalThis.piForumTestAgentDir!
