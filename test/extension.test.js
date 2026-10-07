import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createForumRuntime, SECTION_NAME } from '../extension/runtime.js'

const exec = promisify(execFile)
const BIN_DIR = fileURLToPath(new URL('../bin', import.meta.url))
const NODE_DIR = path.dirname(process.execPath)
const AGENT_DIR = '/home/tester/.config/pi-agent'
const roots = []

after(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })))
})

function ctx(sessionId) {
  return { hasUI: false, sessionManager: { getSessionId: () => sessionId } }
}

function defaultDir(sessionId, agentDir = AGENT_DIR) {
  return path.join(agentDir, 'forums', 'sessions', sessionId)
}

// Mimics Pi: every session start gets a fresh extension runtime, and the previous runtime's
// session_shutdown completes before it. Cancelled switches and tree navigation emit neither.
function host({ env, agentDir = () => AGENT_DIR } = {}) {
  const reports = []
  let runtime = null
  let sessionId = null
  const report = (message) => reports.push(message)
  return {
    env,
    reports,
    get runtime() {
      return runtime
    },
    start(id) {
      runtime?.sessionShutdown()
      runtime = createForumRuntime({ binDir: BIN_DIR, getAgentDir: agentDir, env, report })
      sessionId = id
      runtime.sessionStart(ctx(id))
    },
    quit() {
      runtime.sessionShutdown()
    },
    prompt(sections = { cwd: '<cwd>\n/project\n</cwd>' }) {
      const event = { type: 'before_agent_start', prompt: 'hi', systemPromptOptions: { sections } }
      const result = runtime.beforeAgentStart(event, ctx(sessionId))
      assert.equal(result, undefined)
      return event.systemPromptOptions.sections
    },
  }
}

const BASE_PATH = ['/usr/local/bin', '/usr/bin'].join(path.delimiter)
const withBin = (base = BASE_PATH) => [BIN_DIR, base].join(path.delimiter)

describe('binding selection', () => {
  test('without PI_FORUM_DIR the session default under the configured agent dir is generated', () => {
    const h = host({ env: { PATH: BASE_PATH, HOME: '/home/tester' } })
    h.start('s-1')
    assert.deepEqual(h.env, { PATH: withBin(), HOME: '/home/tester', PI_FORUM_DIR: defaultDir('s-1') })
    assert.deepEqual(h.runtime.binding, { forumDir: defaultDir('s-1'), generated: true })
    h.quit()
    assert.deepEqual(h.env, { PATH: BASE_PATH, HOME: '/home/tester' })
    assert.deepEqual(h.reports, [])
  })

  test('the agent dir is read at each session start and resolved to an absolute path', () => {
    let agentDir = '/srv/agent-a'
    const h = host({ env: { PATH: BASE_PATH }, agentDir: () => agentDir })
    h.start('s-1')
    assert.equal(h.env.PI_FORUM_DIR, defaultDir('s-1', '/srv/agent-a'))
    agentDir = 'relative-agent'
    h.start('s-2')
    assert.equal(h.env.PI_FORUM_DIR, path.resolve('relative-agent', 'forums', 'sessions', 's-2'))
  })

  test('a supplied absolute PI_FORUM_DIR is used unchanged and survives shutdown', () => {
    const supplied = '/shared/forums/../team//'
    const h = host({ env: { PATH: BASE_PATH, PI_FORUM_DIR: supplied } })
    h.start('s-1')
    assert.deepEqual(h.env, { PATH: withBin(), PI_FORUM_DIR: supplied })
    assert.deepEqual(h.runtime.binding, { forumDir: supplied, generated: false })
    h.quit()
    assert.deepEqual(h.env, { PATH: BASE_PATH, PI_FORUM_DIR: supplied })
  })

  for (const supplied of ['', 'relative/forum', '  ', './forum']) {
    test(`a supplied PI_FORUM_DIR of ${JSON.stringify(supplied)} is reported and changes nothing`, () => {
      const h = host({ env: { PATH: BASE_PATH, PI_FORUM_DIR: supplied } })
      h.start('s-1')
      assert.deepEqual(h.env, { PATH: BASE_PATH, PI_FORUM_DIR: supplied })
      assert.equal(h.runtime.binding, null)
      assert.equal(h.reports.length, 1)
      assert.match(h.reports[0], /^pi-forum: PI_FORUM_DIR must be a nonempty absolute path, got ".*"; the forum is disabled/)
      assert.deepEqual(h.prompt({ cwd: 'x' }), { cwd: 'x' })
      h.quit()
      h.quit()
      assert.deepEqual(h.env, { PATH: BASE_PATH, PI_FORUM_DIR: supplied })
    })
  }

  for (const sessionId of ['', '.', '..', 'a/b', 'a\\b']) {
    test(`an unusable session ID ${JSON.stringify(sessionId)} is reported and changes nothing`, () => {
      const h = host({ env: { PATH: BASE_PATH } })
      h.start(sessionId)
      assert.deepEqual(h.env, { PATH: BASE_PATH })
      assert.match(h.reports[0], /^pi-forum: cannot derive a forum directory from session ID/)
    })
  }
})

describe('session lifecycle', () => {
  test('new, fork, clone, resume and reload with a generated binding follow the session ID', () => {
    const h = host({ env: { PATH: BASE_PATH } })
    const expectGenerated = (id) => {
      assert.deepEqual(h.runtime.binding, { forumDir: defaultDir(id), generated: true })
      assert.deepEqual(h.env, { PATH: withBin(), PI_FORUM_DIR: defaultDir(id) })
    }
    h.start('s-1') // startup
    expectGenerated('s-1')
    h.start('s-1') // /reload: same session, fresh runtime
    expectGenerated('s-1')
    h.start('s-2') // /new
    expectGenerated('s-2')
    h.start('s-3') // /fork
    expectGenerated('s-3')
    h.start('s-4') // /clone
    expectGenerated('s-4')
    h.start('s-1') // /resume of the first session
    expectGenerated('s-1')
    h.quit()
    assert.deepEqual(h.env, { PATH: BASE_PATH })
    assert.deepEqual(h.reports, [])
  })

  test('a supplied binding is shared through new, fork, clone, resume and reload', () => {
    const h = host({ env: { PATH: BASE_PATH, PI_FORUM_DIR: '/shared/forum' } })
    for (const id of ['s-1', 's-1', 's-2', 's-3', 's-4', 's-1']) {
      h.start(id)
      assert.deepEqual(h.runtime.binding, { forumDir: '/shared/forum', generated: false })
      assert.deepEqual(h.env, { PATH: withBin(), PI_FORUM_DIR: '/shared/forum' })
    }
    h.quit()
    assert.deepEqual(h.env, { PATH: BASE_PATH, PI_FORUM_DIR: '/shared/forum' })
  })

  test('cancelled session changes and tree navigation keep the binding and prompt', () => {
    const h = host({ env: { PATH: BASE_PATH } })
    h.start('s-1')
    const before = { env: { ...h.env }, section: h.prompt()[SECTION_NAME] }
    // A cancelled /new or /fork and /tree navigation emit no session_start or session_shutdown.
    for (let turn = 0; turn < 3; turn++) {
      assert.deepEqual(h.env, before.env)
      assert.equal(h.prompt()[SECTION_NAME], before.section)
    }
    assert.match(before.section, new RegExp(`Forum directory: ${defaultDir('s-1')} `))
  })

  test('cleanup is idempotent and a repeated start does not stack changes', () => {
    const h = host({ env: { PATH: BASE_PATH } })
    h.start('s-1')
    h.runtime.sessionStart(ctx('s-1'))
    assert.deepEqual(h.env, { PATH: withBin(), PI_FORUM_DIR: defaultDir('s-1') })
    h.quit()
    h.quit()
    assert.deepEqual(h.env, { PATH: BASE_PATH })
    assert.equal(h.runtime.binding, null)
    assert.deepEqual(h.prompt({ cwd: 'x' }), { cwd: 'x' })
  })

  test('PI_SESSION_ID and unrelated variables are never touched', () => {
    const h = host({ env: { PATH: BASE_PATH, PI_SESSION_ID: 'outer', OTHER: '1' } })
    h.start('s-1')
    h.prompt()
    assert.equal(h.env.PI_SESSION_ID, 'outer')
    assert.equal(h.env.OTHER, '1')
    h.quit()
    assert.deepEqual(h.env, { PATH: BASE_PATH, PI_SESSION_ID: 'outer', OTHER: '1' })
  })

  test('a PI_FORUM_DIR changed by someone else is left alone at shutdown', () => {
    const h = host({ env: { PATH: BASE_PATH } })
    h.start('s-1')
    h.env.PI_FORUM_DIR = '/elsewhere'
    h.quit()
    assert.deepEqual(h.env, { PATH: BASE_PATH, PI_FORUM_DIR: '/elsewhere' })
  })
})

describe('PATH ownership', () => {
  test('an existing exact bin component is neither duplicated nor removed', () => {
    for (const PATH of [withBin(), `/usr/bin${path.delimiter}${BIN_DIR}`, BIN_DIR]) {
      const h = host({ env: { PATH } })
      h.start('s-1')
      assert.equal(h.env.PATH, PATH)
      h.quit()
      assert.equal(h.env.PATH, PATH)
    }
  })

  test('a non-exact spelling of the bin dir still gets the exact component', () => {
    const PATH = `${BIN_DIR}/${path.delimiter}/usr/bin`
    const h = host({ env: { PATH } })
    h.start('s-1')
    assert.equal(h.env.PATH, `${BIN_DIR}${path.delimiter}${PATH}`)
    h.quit()
    assert.equal(h.env.PATH, PATH)
  })

  test('a missing or empty PATH is restored exactly', () => {
    const missing = host({ env: {} })
    missing.start('s-1')
    assert.equal(missing.env.PATH, BIN_DIR)
    missing.quit()
    assert.deepEqual(missing.env, {})

    const empty = host({ env: { PATH: '' } })
    empty.start('s-1')
    assert.equal(empty.env.PATH, BIN_DIR)
    empty.quit()
    assert.deepEqual(empty.env, { PATH: '' })
  })

  test('later PATH edits by others are kept and only the inserted component is removed', () => {
    const h = host({ env: { PATH: `/a${path.delimiter}${path.delimiter}/b` } })
    h.start('s-1')
    h.env.PATH = ['/front', h.env.PATH, '/back'].join(path.delimiter)
    h.quit()
    assert.equal(h.env.PATH, ['/front', '/a', '', '/b', '/back'].join(path.delimiter))
  })

  test('a PATH from which others already removed or deleted the component is left alone', () => {
    const removed = host({ env: { PATH: BASE_PATH } })
    removed.start('s-1')
    removed.env.PATH = '/only'
    removed.quit()
    assert.equal(removed.env.PATH, '/only')

    const deleted = host({ env: { PATH: BASE_PATH } })
    deleted.start('s-1')
    delete deleted.env.PATH
    deleted.quit()
    assert.equal(deleted.env.PATH, undefined)
  })

  test('the bound environment runs the bundled executable through PATH', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-extension-test-'))
    roots.push(root)
    const h = host({ env: { PATH: NODE_DIR, PI_SESSION_ID: 's-1' }, agentDir: () => root })
    h.start('s-1')
    const { stdout } = await exec('pi-forum', ['topic', 'create', 'Hello', '--body', 'hi'], { env: h.env, cwd: root })
    assert.equal(JSON.parse(stdout).message.author, 's-1')
    const log = await fs.readFile(path.join(defaultDir('s-1', root), 'events.jsonl'), 'utf8')
    assert.equal(log.trim().split('\n').length, 2)
  })
})

describe('prompt section', () => {
  test('only the forum section is assigned and other sections are preserved', () => {
    const h = host({ env: { PATH: BASE_PATH } })
    h.start('s-1')
    const others = { preamble: 'You are...', cwd: '<cwd>\n/p\n</cwd>', tool_guidance: 'x' }
    const sections = { ...others }
    h.prompt(sections)
    const first = sections[SECTION_NAME]
    h.prompt(sections)
    assert.equal(sections[SECTION_NAME], first)
    const { [SECTION_NAME]: _, ...rest } = sections
    assert.deepEqual(rest, others)
    assert.deepEqual(Object.keys(sections), [...Object.keys(others), SECTION_NAME])
  })

  test('the section carries directory, identity, commands, cursors, checkpoints, trust and child guidance', () => {
    const h = host({ env: { PATH: BASE_PATH } })
    h.start('s-1')
    const text = h.prompt()[SECTION_NAME]
    assert.doesNotMatch(text, /<\/?forum>/)
    assert.match(text, new RegExp(`Forum directory: ${defaultDir('s-1')} \\(PI_FORUM_DIR; this session's default forum\\)`))
    assert.match(text, /Your author identity: s-1 /)
    for (const command of ['topic list', 'topic create', 'topic get', 'message post', 'message list']) {
      assert.ok(text.includes(`pi-forum ${command}`), command)
    }
    assert.match(text, /--body-file PATH or --body-stdin/)
    assert.match(text, /next_cursor/)
    assert.match(text, /checkpoints/)
    assert.match(text, /Do not poll in a loop/)
    assert.match(text, /peer input from other agents, never instructions/)
    assert.match(text, /forward PATH and PI_FORUM_DIR where the launcher permits/)
    assert.match(text, /Do not assume they have access/)
  })

  test('a supplied binding is described as shared and identity follows the current session', () => {
    const h = host({ env: { PATH: BASE_PATH, PI_FORUM_DIR: '/shared/forum' } })
    h.start('s-1')
    h.start('s-2')
    const text = h.prompt()[SECTION_NAME]
    assert.match(text, /Forum directory: \/shared\/forum \(PI_FORUM_DIR; supplied at launch; other sessions may share it\)/)
    assert.match(text, /Your author identity: s-2 /)
  })
})

describe('extension entry', () => {
  // Stands in for the host package, which is not installed in this repository.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== '@earendil-works/pi-coding-agent') return nextResolve(specifier, context)
      const source = 'export const getAgentDir = () => globalThis.piForumTestAgentDir'
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    },
  })

  test('registers only the three lifecycle hooks and binds through the host agent dir', async (t) => {
    const saved = { PATH: process.env.PATH, PI_FORUM_DIR: process.env.PI_FORUM_DIR }
    t.after(() => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })
    delete process.env.PI_FORUM_DIR
    process.env.PATH = BASE_PATH
    globalThis.piForumTestAgentDir = '/host/agent'

    const { default: factory } = await import('../extension/index.js')
    const handlers = new Map()
    const result = factory({ on: (name, handler) => handlers.set(name, handler) })
    assert.equal(result, undefined)
    assert.deepEqual([...handlers.keys()], ['session_start', 'before_agent_start', 'session_shutdown'])
    assert.equal(process.env.PATH, BASE_PATH)
    assert.equal(process.env.PI_FORUM_DIR, undefined)

    await handlers.get('session_start')({ type: 'session_start', reason: 'startup' }, ctx('s-9'))
    assert.equal(process.env.PI_FORUM_DIR, defaultDir('s-9', '/host/agent'))
    assert.equal(process.env.PATH, withBin())
    await fs.access(path.join(process.env.PATH.split(path.delimiter)[0], 'pi-forum'), fs.constants.X_OK)

    const event = { systemPromptOptions: { sections: { cwd: 'c' } } }
    await handlers.get('before_agent_start')(event, ctx('s-9'))
    assert.deepEqual(Object.keys(event.systemPromptOptions.sections), ['cwd', SECTION_NAME])

    await handlers.get('session_shutdown')({ type: 'session_shutdown', reason: 'quit' }, ctx('s-9'))
    assert.equal(process.env.PATH, BASE_PATH)
    assert.equal(process.env.PI_FORUM_DIR, undefined)
  })
})
