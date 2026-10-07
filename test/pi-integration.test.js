// Real-host acceptance: loads pi-forum into an installed Pi through Pi's own extension loader,
// session runtime, event dispatch, prompt renderer and bash tool. It needs a Pi installation, so it
// runs only when PI_FORUM_TEST_PI_ROOT names the root of an installed @earendil-works/pi-coding-agent:
//
//   PI_FORUM_TEST_PI_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent node --test test/pi-integration.test.js
//
// With the variable set, a root that cannot be loaded fails the suite. Every run uses its own agent
// directory, sessions, working directory, HOME, TMPDIR and npm cache under one temp directory, and
// makes no model requests: the session lifecycle and before_agent_start are driven directly.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PI_ROOT = process.env.PI_FORUM_TEST_PI_ROOT
const HOST_PACKAGE = '@earendil-works/pi-coding-agent'
const NODE_DIR = path.dirname(process.execPath)
const BASE_PATH = [NODE_DIR, '/usr/bin', '/bin'].join(path.delimiter)

const SKIP_REASON =
  'host-specific: set PI_FORUM_TEST_PI_ROOT to an installed @earendil-works/pi-coding-agent root to run it'

let pi
let piManifest
let temp
let savedEnv
let probes
let calls = 0
const packages = []

// Replaces the whole process environment, so nothing from the caller's shell or Pi session leaks in.
function setEnvironment(env) {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, env)
}

// Two probe extensions load around pi-forum and record what each lifecycle event sees before and
// after pi-forum's own handler, plus the rendered prompt and the extension context Pi passes.
function probeSource(position) {
  return `export default function (pi) {
  const state = globalThis.piForumProbe
  for (const name of ['session_start', 'session_shutdown']) {
    pi.on(name, (event, ctx) => {
      state.events.push({
        probe: ${JSON.stringify(position)},
        type: event.type,
        reason: event.reason,
        sessionId: ctx.sessionManager.getSessionId(),
        forumDir: process.env.PI_FORUM_DIR,
        path: process.env.PATH,
      })
    })
  }
  pi.on('before_agent_start', (event, ctx) => {
    ${position === 'before' ? "event.systemPromptOptions.sections.team_notes = 'Notes from another extension.'" : ''}
    state.prompts[${JSON.stringify(position)}] = event.systemPrompt
    state.ctx = ctx
  })
}
`
}

async function setUp() {
  piManifest = JSON.parse(await fs.readFile(path.join(PI_ROOT, 'package.json'), 'utf8'))
  assert.equal(piManifest.name, HOST_PACKAGE, `${PI_ROOT} is not the ${HOST_PACKAGE} package root`)
  temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-pi-test-')))
  for (const dir of ['home', 'tmp', 'npm-cache', 'xdg', 'probes', 'extracted']) await fs.mkdir(path.join(temp, dir))
  savedEnv = { ...process.env }
  setEnvironment({
    PATH: BASE_PATH,
    HOME: path.join(temp, 'home'),
    TMPDIR: path.join(temp, 'tmp'),
    XDG_CONFIG_HOME: path.join(temp, 'xdg', 'config'),
    XDG_CACHE_HOME: path.join(temp, 'xdg', 'cache'),
    XDG_DATA_HOME: path.join(temp, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(temp, 'xdg', 'state'),
    npm_config_cache: path.join(temp, 'npm-cache'),
    npm_config_update_notifier: 'false',
    PI_CODING_AGENT_DIR: path.join(temp, 'unused-agent'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
  })

  pi = await import(pathToFileURL(path.join(PI_ROOT, piManifest.exports['.'].import)).href)

  probes = {}
  for (const position of ['before', 'after']) {
    probes[position] = path.join(temp, 'probes', `probe-${position}.js`)
    await fs.writeFile(probes[position], probeSource(position))
  }

  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', temp], { cwd: ROOT })
  const [{ filename }] = JSON.parse(stdout)
  await exec('tar', ['-xzf', path.join(temp, filename), '-C', path.join(temp, 'extracted')])
  packages.push({ label: 'source checkout', dir: ROOT.replace(/\/$/, '') })
  packages.push({ label: 'packed tarball', dir: path.join(temp, 'extracted', 'package') })
}

async function tearDown() {
  if (savedEnv) setEnvironment(savedEnv)
  if (temp) await fs.rm(temp, { recursive: true, force: true })
}

// Starts a Pi session runtime like the CLI does, with its own agent dir, sessions and project.
// mode "extension" loads the package as `pi -e DIR` does; "settings" relies on `pi install`.
async function openHost(packageDir, { supplied, mode = 'extension' } = {}) {
  const dir = await fs.mkdtemp(path.join(temp, 'host-'))
  const agentDir = path.join(dir, 'agent')
  const project = path.join(dir, 'project')
  const sessions = path.join(dir, 'sessions')
  for (const d of [agentDir, project, sessions]) await fs.mkdir(d)
  process.env.PATH = BASE_PATH
  process.env.PI_CODING_AGENT_DIR = agentDir
  if (supplied === undefined) delete process.env.PI_FORUM_DIR
  else process.env.PI_FORUM_DIR = supplied
  if (mode === 'settings') await piCli(['install', packageDir], { cwd: project })

  const extensionPaths =
    mode === 'extension' ? [probes.before, packageDir, probes.after] : [probes.before, probes.after]
  globalThis.piForumProbe = { events: [], prompts: {} }
  const errors = []
  const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await pi.createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: extensionPaths,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      },
    })
    const created = await pi.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })
    return { ...created, services, diagnostics: services.diagnostics }
  }
  const bind = (session) => session.bindExtensions({ onError: (error) => errors.push(error) })
  const runtime = await pi.createAgentSessionRuntime(createRuntime, {
    cwd: project,
    agentDir: pi.getAgentDir(),
    sessionManager: pi.SessionManager.create(project, sessions),
  })
  runtime.setRebindSession(bind)
  await bind(runtime.session)
  return {
    runtime,
    agentDir,
    project,
    errors,
    probe: globalThis.piForumProbe,
    get sessionId() {
      return runtime.session.sessionId
    },
    defaultDir: (id) => path.join(agentDir, 'forums', 'sessions', id),
  }
}

function piCli(args, options) {
  return exec(process.execPath, [path.join(PI_ROOT, piManifest.bin.pi), ...args], options)
}

// The extension Pi loaded from packageDir, with no load errors or warnings for it.
function loadedExtension(host, packageDir) {
  const result = host.runtime.services.resourceLoader.getExtensions()
  assert.deepEqual(result.errors, [])
  const entry = path.join(packageDir, 'extension', 'index.js')
  const extension = result.extensions.find((ext) => ext.resolvedPath === entry)
  assert.ok(extension, `Pi did not load ${entry}; loaded: ${result.extensions.map((ext) => ext.resolvedPath)}`)
  assert.deepEqual((result.warnings ?? []).filter((w) => w.path.startsWith(packageDir)), [])
  return extension
}

// Dispatches before_agent_start through Pi's runner, as the start of an agent run does.
async function startRun(host) {
  const { session } = host.runtime
  const options = {
    cwd: host.project,
    selectedTools: session.getActiveToolNames(),
    sections: { project_rules: 'Keep changes small.' },
  }
  const result = await session.extensionRunner.emitBeforeAgentStart('Check the forum.', undefined, options)
  assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined)
  return { sections: result.systemPromptOptions.sections, ...host.probe.prompts }
}

// Runs a command with Pi's standard bash tool and the extension context of the current run.
async function bash(host, command) {
  const tool = pi.createBashTool(host.project)
  const result = await tool.execute(`call-${++calls}`, { command }, undefined, undefined, host.probe.ctx)
  return result.structuredContent
}

const quote = (arg) => `'${arg.replaceAll("'", `'\\''`)}'`

async function forum(host, args) {
  const { output, exit_code: code } = await bash(host, `pi-forum ${args.map(quote).join(' ')}`)
  assert.equal(code, 0, output)
  return JSON.parse(output)
}

// Adds a user/assistant exchange without a model so the session file exists for resume and fork.
function converse(host, text) {
  const manager = host.runtime.session.sessionManager
  const user = manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() })
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  })
  return user
}

// Takes the lifecycle events recorded since the last call.
function takeEvents(host) {
  return host.probe.events.splice(0)
}

// What a session replacement must look like: the old runtime restores everything before the new
// one starts, and the new one binds the expected directory.
function assertReplacement(host, events, { reason, from, to, forumDir, packageDir, supplied }) {
  const bin = path.join(packageDir, 'bin')
  const before = supplied
  assert.deepEqual(
    events.map(({ probe, type, reason, sessionId }) => [probe, type, reason, sessionId]),
    [
      ['before', 'session_shutdown', reason, from],
      ['after', 'session_shutdown', reason, from],
      ['before', 'session_start', reason, to],
      ['after', 'session_start', reason, to],
    ],
  )
  assert.equal(events[1].forumDir, before)
  assert.equal(events[1].path, BASE_PATH)
  assert.equal(events[2].forumDir, before)
  assert.equal(events[2].path, BASE_PATH)
  assert.equal(events[3].forumDir, forumDir)
  assert.equal(events[3].path, `${bin}${path.delimiter}${BASE_PATH}`)
  assertBound(host, forumDir, packageDir)
}

function assertBound(host, forumDir, packageDir) {
  assert.equal(process.env.PI_FORUM_DIR, forumDir)
  assert.equal(process.env.PATH, `${path.join(packageDir, 'bin')}${path.delimiter}${BASE_PATH}`)
  assert.equal(process.env.PI_SESSION_ID, undefined)
}

if (!PI_ROOT) test('real Pi host acceptance', { skip: SKIP_REASON }, () => {})
else describe('real Pi host', () => {
  before(setUp)
  after(tearDown)

  test('the host package and its runtime versions are recorded', (t) => {
    t.diagnostic(`${HOST_PACKAGE} ${piManifest.version} at ${PI_ROOT}`)
    t.diagnostic(`node ${process.version}`)
    for (const name of ['createAgentSessionRuntime', 'createBashTool', 'getAgentDir', 'SessionManager']) {
      assert.ok(pi[name], `${HOST_PACKAGE} does not export ${name}`)
    }
  })

  for (const variant of [0, 1]) {
    describe(['source checkout', 'packed tarball'][variant], () => {
      const pkg = () => packages[variant]

      test('loads through Pi with only the three lifecycle hooks', async () => {
        const host = await openHost(pkg().dir)
        try {
          const extension = loadedExtension(host, pkg().dir)
          assert.deepEqual([...extension.handlers.keys()].sort(), ['before_agent_start', 'session_shutdown', 'session_start'])
          assert.equal(extension.tools.size, 0)
          assert.equal(extension.commands.size, 0)
          assert.deepEqual(host.errors, [])
        } finally {
          await host.runtime.dispose()
        }
      })

      test('a generated binding follows startup, reload, /new, /resume, /fork, /clone, /tree and quit', async () => {
        const { dir } = pkg()
        const host = await openHost(dir)
        assert.equal(pi.getAgentDir(), host.agentDir)
        const first = host.sessionId
        const firstFile = host.runtime.session.sessionFile

        // Startup: bound to the session default under the configured agent dir.
        let events = takeEvents(host)
        assert.deepEqual(events.map((e) => [e.probe, e.reason, e.sessionId]), [['before', 'startup', first], ['after', 'startup', first]])
        assert.equal(events[0].forumDir, undefined)
        assert.equal(events[0].path, BASE_PATH)
        assertBound(host, host.defaultDir(first), dir)

        // A run's prompt gets the forum section; other sections and the rendered prompt are kept.
        let run = await startRun(host)
        assert.deepEqual(Object.keys(run.sections), ['project_rules', 'team_notes', 'forum'])
        assert.equal(run.sections.project_rules, 'Keep changes small.')
        assert.ok(run.after.startsWith(run.before), 'rendered prompt keeps everything before the forum section')
        assert.match(run.before, /<project_rules>\nKeep changes small\.\n<\/project_rules>/)
        assert.match(run.before, /<team_notes>\nNotes from another extension\.\n<\/team_notes>/)
        assert.match(run.after.slice(run.before.length), /^\s*<forum>\n[\s\S]+\n<\/forum>\s*$/)
        assert.ok(run.after.includes(`Forum directory: ${host.defaultDir(first)} (PI_FORUM_DIR; this session's default forum)`))
        assert.ok(run.after.includes(`Your author identity: ${first} `))

        // Pi's bash tool finds the bundled executable and supplies the current session ID.
        const located = await bash(host, 'command -v pi-forum; printf "%s\\n" "$PI_SESSION_ID" "$PI_FORUM_DIR"')
        assert.equal(located.output, `${path.join(dir, 'bin', 'pi-forum')}\n${first}\n${host.defaultDir(first)}\n`)
        const { topic } = await forum(host, ['topic', 'create', 'Plan', '--body', 'first post'])
        assert.equal(topic.created_by, first)
        assert.equal(topic.origin_session_id, first)
        await fs.access(path.join(host.defaultDir(first), 'events.jsonl'))
        const userEntry = converse(host, 'first question')
        converse(host, 'second question')
        const forkEntry = host.runtime.session.sessionManager.getLeafId()
        const secondUser = host.runtime.session.sessionManager.getEntry(forkEntry).parentId

        // /reload: the old runtime restores, the new one rebinds the same session forum.
        await host.runtime.session.reload()
        assertReplacement(host, takeEvents(host), { reason: 'reload', from: first, to: first, forumDir: host.defaultDir(first), packageDir: dir })
        await startRun(host)
        const reply = await forum(host, ['message', 'post', topic.id, '--body', 'after reload'])
        assert.equal(reply.message.author, first)

        // /new: a fresh default forum for the new session ID.
        await host.runtime.newSession()
        const second = host.sessionId
        assert.notEqual(second, first)
        assertReplacement(host, takeEvents(host), { reason: 'new', from: first, to: second, forumDir: host.defaultDir(second), packageDir: dir })
        run = await startRun(host)
        assert.ok(run.after.includes(`Forum directory: ${host.defaultDir(second)} `))
        assert.ok(run.after.includes(`Your author identity: ${second} `))
        assert.deepEqual((await forum(host, ['topic', 'list'])).items, [])
        const own = await forum(host, ['topic', 'create', 'Second session'])
        assert.equal(own.topic.created_by, second)

        // /resume of the first session: the same default forum, with its earlier posts.
        await host.runtime.switchSession(firstFile)
        assert.equal(host.sessionId, first)
        assertReplacement(host, takeEvents(host), { reason: 'resume', from: second, to: first, forumDir: host.defaultDir(first), packageDir: dir })
        await startRun(host)
        const resumed = await forum(host, ['message', 'list', '--topic', topic.id])
        assert.deepEqual(resumed.items.map((m) => [m.body, m.author]), [['first post', first], ['after reload', first]])

        // /tree: navigation stays in the session, with no lifecycle events and the same binding.
        const before = (await startRun(host)).after
        const navigation = await host.runtime.session.navigateTree(userEntry, { summarize: false })
        assert.equal(navigation.cancelled, false)
        assert.deepEqual(takeEvents(host), [])
        assertBound(host, host.defaultDir(first), dir)
        assert.equal((await startRun(host)).after, before)

        // /fork from the second question: a new session and default forum.
        await host.runtime.session.navigateTree(forkEntry, { summarize: false })
        await host.runtime.fork(secondUser)
        const forked = host.sessionId
        assert.ok(![first, second].includes(forked))
        assertReplacement(host, takeEvents(host), { reason: 'fork', from: first, to: forked, forumDir: host.defaultDir(forked), packageDir: dir })
        await startRun(host)
        assert.equal((await forum(host, ['topic', 'create', 'Forked'])).topic.created_by, forked)

        // /clone at the current leaf: Pi reports it as a fork, and it gets its own forum too.
        await host.runtime.fork(host.runtime.session.sessionManager.getLeafId(), { position: 'at' })
        const cloned = host.sessionId
        assert.ok(![first, second, forked].includes(cloned))
        assertReplacement(host, takeEvents(host), { reason: 'fork', from: forked, to: cloned, forumDir: host.defaultDir(cloned), packageDir: dir })

        // Quit: everything pi-forum assigned is restored, and the forum files stay.
        await host.runtime.dispose()
        events = takeEvents(host)
        assert.deepEqual(events.map((e) => [e.probe, e.type, e.reason]), [['before', 'session_shutdown', 'quit'], ['after', 'session_shutdown', 'quit']])
        assert.equal(process.env.PATH, BASE_PATH)
        assert.equal(process.env.PI_FORUM_DIR, undefined)
        assert.deepEqual(host.errors, [])
        const forums = (await fs.readdir(path.join(host.agentDir, 'forums', 'sessions'))).sort()
        assert.deepEqual(forums, [first, second, forked].sort())
      })

      test('a supplied PI_FORUM_DIR is shared across sessions and survives quit', async () => {
        const { dir } = pkg()
        const shared = path.join(temp, `shared forum ${variant}`)
        const host = await openHost(dir, { supplied: shared })
        const first = host.sessionId
        const startup = takeEvents(host)
        assert.deepEqual(startup.map((e) => [e.probe, e.reason, e.forumDir]), [['before', 'startup', shared], ['after', 'startup', shared]])
        assert.equal(startup[0].path, BASE_PATH)
        assertBound(host, shared, dir)
        let run = await startRun(host)
        assert.ok(run.after.includes(`Forum directory: ${shared} (PI_FORUM_DIR; supplied at launch; other sessions may share it)`))
        const { topic } = await forum(host, ['topic', 'create', 'Shared', '--body', 'from the first session'])
        converse(host, 'question')
        const firstFile = host.runtime.session.sessionFile

        await host.runtime.newSession()
        const second = host.sessionId
        assertReplacement(host, takeEvents(host), { reason: 'new', from: first, to: second, forumDir: shared, packageDir: dir, supplied: shared })
        run = await startRun(host)
        assert.ok(run.after.includes(`Your author identity: ${second} `))
        await forum(host, ['message', 'post', topic.id, '--body', 'from the second session'])

        await host.runtime.session.reload()
        assertReplacement(host, takeEvents(host), { reason: 'reload', from: second, to: second, forumDir: shared, packageDir: dir, supplied: shared })
        await host.runtime.switchSession(firstFile)
        assertReplacement(host, takeEvents(host), { reason: 'resume', from: second, to: first, forumDir: shared, packageDir: dir, supplied: shared })
        await startRun(host)
        const listed = await forum(host, ['message', 'list', '--topic', topic.id])
        assert.deepEqual(
          listed.items.map((m) => [m.author, m.origin_session_id]),
          [[first, first], [second, second]],
        )

        await host.runtime.dispose()
        assert.equal(process.env.PI_FORUM_DIR, shared)
        assert.equal(process.env.PATH, BASE_PATH)
        await assert.rejects(fs.access(path.join(host.agentDir, 'forums')))
        assert.deepEqual(host.errors, [])
      })

      test('an invalid PI_FORUM_DIR is reported and leaves the session without the forum', async (t) => {
        const reports = []
        t.mock.method(console, 'error', (...args) => reports.push(args.join(' ')))
        const host = await openHost(pkg().dir, { supplied: 'relative/forum' })
        try {
          assert.equal(reports.length, 1)
          assert.match(reports[0], /^pi-forum: PI_FORUM_DIR must be a nonempty absolute path, got "relative\/forum"; the forum is disabled/)
          assert.equal(process.env.PI_FORUM_DIR, 'relative/forum')
          assert.equal(process.env.PATH, BASE_PATH)
          const run = await startRun(host)
          assert.deepEqual(Object.keys(run.sections), ['project_rules', 'team_notes'])
          assert.equal((await bash(host, 'command -v pi-forum')).exit_code, 1)
        } finally {
          await host.runtime.dispose()
        }
        assert.equal(process.env.PI_FORUM_DIR, 'relative/forum')
        assert.equal(process.env.PATH, BASE_PATH)
        assert.deepEqual(host.errors, [])
      })

      test('pi install records the package in the configured agent dir and Pi loads it from settings', async () => {
        const { dir } = pkg()
        const host = await openHost(dir, { mode: 'settings' })
        try {
          const settings = JSON.parse(await fs.readFile(path.join(host.agentDir, 'settings.json'), 'utf8'))
          assert.equal(settings.packages.length, 1)
          assert.equal(path.resolve(host.agentDir, settings.packages[0]), dir)
          const { stdout } = await piCli(['list'], { cwd: host.project })
          assert.ok(stdout.includes(dir), stdout)
          loadedExtension(host, dir)
          assertBound(host, host.defaultDir(host.sessionId), dir)
          const run = await startRun(host)
          assert.ok(run.sections.forum.includes(`Your author identity: ${host.sessionId} `))
          const created = await forum(host, ['topic', 'create', 'Installed'])
          assert.equal(created.topic.created_by, host.sessionId)
        } finally {
          await host.runtime.dispose()
        }
        assert.equal(process.env.PATH, BASE_PATH)
        assert.equal(process.env.PI_FORUM_DIR, undefined)
      })
    })
  }

  test('nothing was written outside the isolated temp directory', async () => {
    assert.deepEqual(await fs.readdir(path.join(temp, 'home')), [])
  })
})
