import assert from 'node:assert/strict'
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { createPreferenceStore } from '../extension/preferences.js'

const roots = []

after(() => {
  for (const root of roots) nodeFs.rmSync(root, { recursive: true, force: true })
})

// A temporary tree with an agent directory and a project working directory, neither created yet.
function setup({ fs } = {}) {
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'pi-forum-preferences-'))
  roots.push(root)
  const agentDir = path.join(root, 'agent')
  const cwd = path.join(root, 'project')
  return {
    root,
    agentDir,
    cwd,
    userFile: path.join(agentDir, 'forum.json'),
    projectFile: path.join(cwd, '.pi', 'forum.json'),
    store: createPreferenceStore({ getAgentDir: () => agentDir, fs }),
  }
}

function ctx(cwd, trusted = true) {
  return { cwd, isProjectTrusted: () => trusted }
}

function write(file, value) {
  nodeFs.mkdirSync(path.dirname(file), { recursive: true })
  nodeFs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

const read = (file) => JSON.parse(nodeFs.readFileSync(file, 'utf8'))
const exists = (file) => nodeFs.existsSync(file)

// Every file under dir, relative and sorted.
function tree(dir) {
  if (!exists(dir)) return []
  return nodeFs.readdirSync(dir, { recursive: true }).sort()
}

// node:fs with every call recorded by name.
function spyFs() {
  const calls = []
  const fs = {}
  for (const name of ['readFileSync', 'mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync']) {
    fs[name] = (...args) => {
      calls.push([name, ...args])
      return nodeFs[name](...args)
    }
  }
  return { fs, calls }
}

describe('saved values', () => {
  test('the user default round-trips without a project context', () => {
    const { store, userFile } = setup()
    assert.deepEqual(store.set('user', true), { ok: true, scope: 'user', path: userFile, enabled: true, changed: true })
    assert.deepEqual(read(userFile), { enabled: true })
    assert.equal(nodeFs.readFileSync(userFile, 'utf8'), '{\n  "enabled": true\n}\n')
    const loaded = store.load()
    assert.equal(loaded.enabled, true)
    assert.equal(loaded.source, 'user')
    assert.deepEqual(loaded.user, { scope: 'user', path: userFile, exists: true, enabled: true, ignored: null, error: null })
    assert.equal(loaded.project.ignored.code, 'no-cwd')

    assert.equal(store.set('user', false).changed, true)
    assert.deepEqual(read(userFile), { enabled: false })
    assert.equal(store.load().enabled, false)
  })

  test('the project default round-trips in a trusted working directory', () => {
    const { store, cwd, projectFile } = setup()
    assert.deepEqual(store.set('project', false, ctx(cwd)), { ok: true, scope: 'project', path: projectFile, enabled: false, changed: true })
    assert.deepEqual(read(projectFile), { enabled: false })
    const loaded = store.load(ctx(cwd))
    assert.equal(loaded.enabled, false)
    assert.equal(loaded.source, 'project')
    assert.deepEqual(loaded.project, { scope: 'project', path: projectFile, exists: true, enabled: false, ignored: null, error: null })
    assert.equal(store.set('project', true, ctx(cwd)).changed, true)
    assert.equal(store.load(ctx(cwd)).enabled, true)
  })

  test('nothing saved inherits the built-in default and loading creates nothing', () => {
    const { store, root, cwd } = setup()
    nodeFs.mkdirSync(cwd)
    const { fs, calls } = spyFs()
    const spied = createPreferenceStore({ getAgentDir: () => path.join(root, 'agent'), fs })
    for (const subject of [store, spied]) {
      const loaded = subject.load(ctx(cwd))
      assert.equal(loaded.enabled, undefined)
      assert.equal(loaded.source, null)
      for (const state of [loaded.user, loaded.project]) {
        assert.equal(state.exists, false)
        assert.equal(state.enabled, undefined)
        assert.equal(state.ignored, null)
        assert.equal(state.error, null)
      }
    }
    assert.deepEqual([...new Set(calls.map(([name]) => name))], ['readFileSync'])
    assert.deepEqual(tree(root), ['project'])
  })

  test('an explicit project false overrides the user default and a missing key inherits it', () => {
    const { store, cwd, projectFile } = setup()
    store.set('user', true)
    assert.deepEqual([store.load(ctx(cwd)).enabled, store.load(ctx(cwd)).source], [true, 'user'])
    store.set('project', false, ctx(cwd))
    assert.deepEqual([store.load(ctx(cwd)).enabled, store.load(ctx(cwd)).source], [false, 'project'])
    write(projectFile, { other: 1 })
    const loaded = store.load(ctx(cwd))
    assert.deepEqual([loaded.enabled, loaded.source, loaded.project.exists, loaded.project.enabled], [true, 'user', true, undefined])
  })

  test('reset removes the key so the scope inherits again', () => {
    const { store, cwd, projectFile, userFile } = setup()
    store.set('user', true)
    store.set('project', false, ctx(cwd))
    assert.deepEqual(store.reset('project', ctx(cwd)), { ok: true, scope: 'project', path: projectFile, enabled: undefined, changed: true })
    assert.deepEqual(read(projectFile), {})
    assert.deepEqual([store.load(ctx(cwd)).enabled, store.load(ctx(cwd)).source], [true, 'user'])
    assert.equal(store.reset('user').changed, true)
    assert.deepEqual(read(userFile), {})
    assert.equal(store.load(ctx(cwd)).enabled, undefined)
    assert.equal(store.reset('user').changed, false)
  })

  test('resetting a missing file succeeds without creating directories', () => {
    const { store, root, cwd, userFile, projectFile } = setup()
    nodeFs.mkdirSync(cwd)
    assert.deepEqual(store.reset('user'), { ok: true, scope: 'user', path: userFile, enabled: undefined, changed: false })
    assert.deepEqual(store.reset('project', ctx(cwd)), { ok: true, scope: 'project', path: projectFile, enabled: undefined, changed: false })
    assert.deepEqual(tree(root), ['project'])
  })

  test('saving the current value does not rewrite the file', () => {
    const { store, userFile } = setup()
    write(userFile, '{"enabled":true}')
    const { fs, calls } = spyFs()
    const spied = createPreferenceStore({ getAgentDir: () => path.dirname(userFile), fs })
    assert.deepEqual(spied.set('user', true), { ok: true, scope: 'user', path: userFile, enabled: true, changed: false })
    assert.deepEqual(calls.map(([name]) => name), ['readFileSync'])
    assert.equal(nodeFs.readFileSync(userFile, 'utf8'), '{"enabled":true}')
  })

  test('unrelated fields are ignored for activation and preserved by updates', () => {
    const { store, cwd, projectFile } = setup()
    const extra = { note: 'keep', nested: { enabled: 'not ours' }, list: [1, 2] }
    write(projectFile, { ...extra, enabled: true })
    assert.equal(store.load(ctx(cwd)).enabled, true)
    store.set('project', false, ctx(cwd))
    assert.deepEqual(read(projectFile), { ...extra, enabled: false })
    store.reset('project', ctx(cwd))
    assert.deepEqual(read(projectFile), extra)
    write(projectFile, extra)
    assert.equal(store.load(ctx(cwd)).enabled, undefined)
    assert.equal(store.load(ctx(cwd)).project.error, null)
  })

  test('set rejects non-boolean values and unknown scopes', () => {
    const { store, root } = setup()
    assert.throws(() => store.set('user', 'true'), TypeError)
    assert.throws(() => store.set('user', undefined), TypeError)
    assert.throws(() => store.set('global', true), TypeError)
    assert.throws(() => store.reset('global'), TypeError)
    assert.throws(() => store.set('workspace', false, ctx(root)), TypeError)
    assert.deepEqual(tree(root), [])
  })
})

describe('project location', () => {
  test('only the exact working directory is consulted, never a parent or sibling', () => {
    const { store, cwd, root } = setup()
    const other = path.join(root, 'other')
    const child = path.join(cwd, 'packages', 'app')
    nodeFs.mkdirSync(child, { recursive: true })
    nodeFs.mkdirSync(path.join(cwd, '.git'))
    nodeFs.mkdirSync(other)
    store.set('project', true, ctx(cwd))
    assert.equal(store.load(ctx(cwd)).enabled, true)
    for (const dir of [other, child]) {
      const loaded = store.load(ctx(dir))
      assert.equal(loaded.enabled, undefined)
      assert.equal(loaded.project.path, path.join(dir, '.pi', 'forum.json'))
      assert.equal(loaded.project.exists, false)
    }
    store.set('project', false, ctx(other))
    assert.deepEqual([store.load(ctx(cwd)).enabled, store.load(ctx(other)).enabled], [true, false])
    assert.equal(exists(path.join(child, '.pi')), false)
  })

  test('a missing or relative working directory leaves the project unused', () => {
    const { store, root } = setup()
    store.set('user', false)
    for (const context of [undefined, {}, { cwd: '', isProjectTrusted: () => true }, { cwd: 'project', isProjectTrusted: () => true }]) {
      const loaded = store.load(context)
      assert.deepEqual(loaded.project.ignored.code, 'no-cwd')
      assert.equal(loaded.project.path, null)
      assert.deepEqual([loaded.enabled, loaded.source], [false, 'user'])
      const saved = store.set('project', true, context)
      assert.equal(saved.ok, false)
      assert.equal(saved.error.code, 'no-cwd')
    }
    assert.deepEqual(tree(root), ['agent', path.join('agent', 'forum.json')])
  })
})

describe('project trust', () => {
  const contexts = {
    denied: { code: 'untrusted', isProjectTrusted: () => false },
    missing: { code: 'trust-unavailable' },
    throwing: {
      code: 'trust-unavailable',
      isProjectTrusted: () => {
        throw new Error('trust store offline')
      },
    },
    'non-boolean': { code: 'trust-unavailable', isProjectTrusted: () => 'yes' },
  }

  for (const [name, { code, isProjectTrusted }] of Object.entries(contexts)) {
    test(`a ${name} trust check ignores the project file and refuses to write it`, () => {
      const { store, cwd, projectFile, userFile } = setup()
      write(projectFile, { enabled: true, other: 1 })
      const before = nodeFs.readFileSync(projectFile, 'utf8')
      const context = isProjectTrusted ? { cwd, isProjectTrusted } : { cwd }
      const { fs, calls } = spyFs()
      const spied = createPreferenceStore({ getAgentDir: () => path.dirname(userFile), fs })

      const loaded = spied.load(context)
      assert.equal(loaded.enabled, undefined)
      assert.deepEqual([loaded.project.path, loaded.project.exists, loaded.project.enabled, loaded.project.error], [projectFile, false, undefined, null])
      assert.equal(loaded.project.ignored.code, code)
      assert.match(loaded.project.ignored.message, /run \/trust and restart Pi, or start Pi with --approve/)
      if (name === 'throwing') assert.match(loaded.project.ignored.message, /trust store offline/)

      for (const result of [spied.set('project', false, context), spied.reset('project', context)]) {
        assert.equal(result.ok, false)
        assert.equal(result.path, projectFile)
        assert.equal(result.error.code, code)
        assert.match(result.error.message, /\/trust and restart Pi, or start Pi with --approve.*not changed/)
      }
      assert.ok(calls.every(([, file]) => typeof file !== 'string' || !file.startsWith(cwd)), 'project files untouched')
      assert.equal(nodeFs.readFileSync(projectFile, 'utf8'), before)

      // The user scope works the same with or without project trust.
      assert.equal(spied.set('user', true, context).ok, true)
      assert.deepEqual([spied.load(context).enabled, spied.load(context).source], [true, 'user'])
      assert.deepEqual(read(userFile), { enabled: true })
    })
  }
})

describe('damaged files', () => {
  const cases = {
    'invalid JSON': ['{"enabled": tru', 'malformed'],
    'empty file': ['', 'malformed'],
    array: ['[true]', 'invalid'],
    null: ['null', 'invalid'],
    string: ['"on"', 'invalid'],
    'string enabled': ['{"enabled":"true"}', 'invalid'],
    'null enabled': ['{"enabled":null}', 'invalid'],
    'numeric enabled': ['{"enabled":1}', 'invalid'],
  }

  for (const [name, [text, code]] of Object.entries(cases)) {
    test(`a project file with ${name} is reported, inherits, and is not replaced`, () => {
      const { store, cwd, projectFile } = setup()
      store.set('user', true)
      write(projectFile, text)
      const loaded = store.load(ctx(cwd))
      assert.deepEqual([loaded.enabled, loaded.source], [true, 'user'])
      assert.equal(loaded.project.exists, true)
      assert.equal(loaded.project.enabled, undefined)
      assert.equal(loaded.project.ignored, null)
      assert.equal(loaded.project.error.code, code)
      assert.ok(loaded.project.error.message.includes(projectFile))
      for (const result of [store.set('project', false, ctx(cwd)), store.reset('project', ctx(cwd))]) {
        assert.equal(result.ok, false)
        assert.equal(result.error.code, code)
        assert.match(result.error.message, /refusing to replace it/)
      }
      assert.equal(nodeFs.readFileSync(projectFile, 'utf8'), text)
      assert.deepEqual(tree(path.dirname(projectFile)), ['forum.json'])
    })
  }

  test('an unreadable user file is reported, inherits, and is not replaced', () => {
    const { store, cwd, userFile } = setup()
    nodeFs.mkdirSync(userFile, { recursive: true })
    const loaded = store.load(ctx(cwd))
    assert.equal(loaded.enabled, undefined)
    assert.equal(loaded.user.exists, true)
    assert.equal(loaded.user.error.code, 'unreadable')
    assert.match(loaded.user.error.message, /cannot read .*forum\.json: .*EISDIR/)
    const result = store.set('user', true)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'unreadable')
    assert.ok(nodeFs.statSync(userFile).isDirectory())

    // A project default still applies.
    store.set('project', true, ctx(cwd))
    assert.deepEqual([store.load(ctx(cwd)).enabled, store.load(ctx(cwd)).source], [true, 'project'])
  })

  test('a failing agent directory lookup is a user error, not a crash', () => {
    const { cwd } = setup()
    const store = createPreferenceStore({
      getAgentDir: () => {
        throw new Error('no home')
      },
    })
    const loaded = store.load(ctx(cwd))
    assert.deepEqual(loaded.user.error, { code: 'agent-dir-unavailable', message: 'cannot locate the Pi agent directory: no home' })
    assert.equal(loaded.user.path, null)
    assert.deepEqual(store.set('user', true), { ok: false, scope: 'user', path: null, error: loaded.user.error })
    assert.equal(store.set('project', true, ctx(cwd)).ok, true)
    assert.deepEqual([store.load(ctx(cwd)).enabled, store.load(ctx(cwd)).source], [true, 'project'])
  })
})

describe('atomic updates', () => {
  test('a new file is written through an exclusive temporary file in the same directory', () => {
    const { cwd, agentDir, projectFile } = setup()
    const { fs, calls } = spyFs()
    const store = createPreferenceStore({ getAgentDir: () => agentDir, fs })
    assert.equal(store.set('project', true, ctx(cwd)).ok, true)
    const names = calls.map(([name]) => name)
    assert.deepEqual(names, ['readFileSync', 'mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync'])
    const [, temp, flags] = calls.find(([name]) => name === 'openSync')
    assert.equal(flags, 'wx')
    assert.equal(path.dirname(temp), path.dirname(projectFile))
    assert.deepEqual(calls.find(([name]) => name === 'renameSync').slice(1), [temp, projectFile])
    assert.deepEqual(tree(path.dirname(projectFile)), ['forum.json'])
  })

  const steps = ['mkdirSync', 'openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']
  for (const step of steps) {
    for (const existing of [true, false]) {
      test(`a failing ${step} ${existing ? 'keeps the existing file' : 'creates no file'} and leaves no temporary file`, () => {
        const { cwd, agentDir, projectFile } = setup()
        const original = '{"other":"keep","enabled":true}'
        if (existing) write(projectFile, original)
        const fs = {
          ...nodeFs,
          [step]: (...args) => {
            // A failed write leaves partial content behind, as a full disk would.
            if (step === 'writeFileSync') nodeFs.writeFileSync(args[0], '{"ena')
            // A failed close still releases the descriptor, as on Linux.
            if (step === 'closeSync') nodeFs.closeSync(args[0])
            throw Object.assign(new Error(`${step} failed`), { code: 'EIO' })
          },
        }
        const store = createPreferenceStore({ getAgentDir: () => agentDir, fs })
        const result = store.set('project', false, ctx(cwd))
        assert.equal(result.ok, false)
        assert.equal(result.path, projectFile)
        assert.equal(result.error.code, 'write-failed')
        assert.equal(result.error.message, `cannot save ${projectFile}: ${step} failed`)
        if (existing) {
          assert.equal(nodeFs.readFileSync(projectFile, 'utf8'), original)
          assert.deepEqual(tree(path.dirname(projectFile)), ['forum.json'])
        } else {
          assert.equal(exists(projectFile), false)
          assert.deepEqual(tree(path.dirname(projectFile)), [])
        }
        const after = createPreferenceStore({ getAgentDir: () => agentDir }).load(ctx(cwd))
        assert.equal(after.enabled, existing ? true : undefined)
        assert.equal(after.project.error, null)
      })
    }
  }

  test('a failed reset keeps the existing value', () => {
    const { cwd, agentDir, projectFile } = setup()
    write(projectFile, { enabled: false })
    const fs = {
      ...nodeFs,
      renameSync: () => {
        throw new Error('rename failed')
      },
    }
    const result = createPreferenceStore({ getAgentDir: () => agentDir, fs }).reset('project', ctx(cwd))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'write-failed')
    assert.deepEqual(read(projectFile), { enabled: false })
    assert.deepEqual(tree(path.dirname(projectFile)), ['forum.json'])
  })

  test('a temporary file that cannot be removed is named in the failure', () => {
    const { agentDir, userFile } = setup()
    const fs = {
      ...nodeFs,
      renameSync: () => {
        throw new Error('rename failed')
      },
      unlinkSync: () => {
        throw new Error('unlink failed')
      },
    }
    const result = createPreferenceStore({ getAgentDir: () => agentDir, fs }).set('user', true)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'write-failed')
    const [temp] = tree(agentDir)
    assert.match(temp, /^\.forum\.json\..+\.tmp$/)
    assert.equal(
      result.error.message,
      `cannot save ${userFile}: rename failed; the temporary file ${path.join(agentDir, temp)} could not be removed: unlink failed`,
    )
    assert.equal(exists(userFile), false)
  })
})
