import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { ROOT } from './checkout.ts'

const exec = promisify(execFile)
const SETUP = path.join(ROOT, 'forum-env.sh')
const BIN = path.join(ROOT, 'bin')
const PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`
const PROBE = `
set -eu
if source "$SETUP" "$@"; then status=0; else status=$?; fi
! declare -F _pi_forum_env >/dev/null
SETUP_STATUS=$status node -e 'console.log(JSON.stringify({
  status: Number(process.env.SETUP_STATUS), dir: process.env.PI_FORUM_DIR,
  path: process.env.PATH, cwd: process.cwd(), args: process.argv.slice(1)
}))' -- "$@"
`

interface State { status: number; dir?: string; path: string; cwd: string; args: string[] }

async function fixture(t: TestContext) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-env test-'))
  t.after(() => fs.rm(cwd, { recursive: true, force: true }))
  const env = { PATH, HOME: cwd, SETUP }
  async function run(args: string[], extra: NodeJS.ProcessEnv = {}) {
    const { stdout, stderr } = await exec('/bin/bash', ['--noprofile', '--norc', '-c', PROBE, 'test', ...args], {
      cwd, env: { ...env, ...extra },
    })
    const state = JSON.parse(stdout) as State
    assert.equal(state.cwd, cwd, 'sourcing must not change the caller directory')
    assert.deepEqual(state.args, args, 'sourcing must not change positional arguments')
    return { ...state, stderr }
  }
  return { cwd, env, run }
}

test('setup requires a directory when PI_FORUM_DIR is unset or empty', async (t) => {
  const { cwd, run } = await fixture(t)
  for (const extra of [{}, { PI_FORUM_DIR: '' }]) {
    const result = await run([], extra)
    assert.equal(result.status, 1)
    assert.equal(result.path, PATH)
    assert.equal(result.dir, extra.PI_FORUM_DIR)
    assert.match(result.stderr, /Usage: source/)
  }
  assert.deepEqual(await fs.readdir(cwd), [])
})

test('absolute and relative directories with spaces are created and exported to child processes', async (t) => {
  const { cwd, run } = await fixture(t)
  for (const arg of [path.join(cwd, 'absolute forum'), 'relative forum/nested']) {
    const result = await run([arg])
    assert.equal(result.status, 0)
    assert.equal(result.stderr, '')
    assert.equal(result.dir, path.resolve(cwd, arg))
    assert.equal(result.path, `${BIN}:${PATH}`)
    assert.deepEqual(await fs.readdir(result.dir!), [], 'setup creates no log or posts')
  }
})

test('-c and --current select .forum in the caller directory, not the package directory', async (t) => {
  const { cwd, run } = await fixture(t)
  for (const flag of ['-c', '--current']) {
    const result = await run([flag])
    assert.equal(result.status, 0)
    assert.equal(result.dir, path.join(cwd, '.forum'))
    assert.equal(result.stderr, '')
  }
  assert.deepEqual(await fs.readdir(cwd), ['.forum'])
})

test('existing PI_FORUM_DIR wins over a directory or --current, and PATH is not duplicated', async (t) => {
  const { cwd, run } = await fixture(t)
  const dir = path.join(cwd, 'existing forum')
  const existingPath = `${PATH}:${BIN}`
  for (const args of [[], ['ignored'], ['-c'], ['--current']]) {
    const result = await run(args, { PI_FORUM_DIR: dir, PATH: existingPath })
    assert.equal(result.status, 0)
    assert.equal(result.dir, dir)
    assert.equal(result.path, existingPath)
    assert.equal(result.stderr, '')
  }
  assert.deepEqual(await fs.readdir(cwd), ['existing forum'])
})

test('bad arguments, relative bindings and mkdir failures leave environment values unchanged', async (t) => {
  const { cwd, run } = await fixture(t)
  for (const args of [['--unknown'], ['one', 'two'], ['--current', 'other'], ['']]) {
    const result = await run(args)
    assert.equal(result.status, 1)
    assert.equal(result.dir, undefined)
    assert.equal(result.path, PATH)
    assert.match(result.stderr, /Usage: source/)
  }
  const relative = await run(['--current'], { PI_FORUM_DIR: 'relative' })
  assert.equal(relative.status, 1)
  assert.equal(relative.dir, 'relative')
  assert.equal(relative.path, PATH)
  assert.match(relative.stderr, /PI_FORUM_DIR must be absolute/)
  assert.deepEqual(await fs.readdir(cwd), [])
  await fs.writeFile(path.join(cwd, 'blocked'), '')
  const blocked = await run(['blocked/child'])
  assert.equal(blocked.status, 1)
  assert.equal(blocked.dir, undefined)
  assert.equal(blocked.path, PATH)
  assert.ok(blocked.stderr)
})

test('sourcing twice is idempotent and works with a relative script path and CDPATH', async (t) => {
  const { cwd, env } = await fixture(t)
  await fs.symlink(ROOT, path.join(cwd, 'package'))
  const { stdout, stderr } = await exec('/bin/bash', ['--noprofile', '--norc', '-c', `
    set -eu
    source "$SETUP" --current
    before=$PATH
    source "$SETUP"
    [[ $PATH == "$before" ]]
    pi-forum topic list
  `], { cwd, env: { ...env, SETUP: 'package/forum-env.sh', CDPATH: '/' } })
  assert.equal(stderr, '')
  const page = JSON.parse(stdout) as { items: unknown[]; has_more: boolean }
  assert.deepEqual(page.items, [])
  assert.equal(page.has_more, false)
})

test('help is harmless; direct execution explains that the script must be sourced', async (t) => {
  const { cwd, env } = await fixture(t)
  const help = await exec('/bin/bash', ['--noprofile', '--norc', '-c', 'source "$SETUP" --help'], { cwd, env })
  assert.match(help.stdout, /Usage: source/)
  assert.equal(help.stderr, '')
  await assert.rejects(exec('/bin/bash', [SETUP, '--current'], { cwd, env }), {
    code: 1, stdout: '', stderr: /Use: source .*forum-env\.sh/,
  })
  assert.deepEqual(await fs.readdir(cwd), [])
})
