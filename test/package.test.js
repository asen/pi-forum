import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ROOT, SOURCE_DIRS, checkoutFiles, copyCheckout, generatedInventory, listFiles, snapshot } from './checkout.js'

const exec = promisify(execFile)
let temp
let tarball
let pkg
let inventory
let tree

// Packs the working tree with npm and extracts the tarball, as an installer would see it. Scripts are
// skipped, so prepack's build neither needs the dev dependencies nor rewrites the working tree: the
// tarball holds the tracked generated files, as Git and local installs use them, and npm run
// check-generated keeps those equal to what the build would write (the build and prepack themselves
// are tested in scratch copies by build.test.js).
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-package-test-'))
  inventory = await generatedInventory()
  tree = await snapshot(ROOT, { files: await checkoutFiles() })
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: ROOT, env: npmEnv('pack') })
  const [{ filename }] = JSON.parse(stdout)
  tarball = path.join(temp, filename)
  const extracted = path.join(temp, 'extracted')
  await fs.mkdir(extracted)
  await exec('tar', ['-xzf', tarball, '-C', extracted])
  pkg = path.join(extracted, 'package')
})

after(async () => {
  if (temp) await fs.rm(temp, { recursive: true, force: true })
})

// npm with its own empty cache. Installs are also offline, so one that needs the registry fails
// instead of reaching the network.
function npmEnv(cache, { offline = false } = {}) {
  return {
    ...process.env,
    npm_config_cache: path.join(temp, `npm-cache-${cache}`),
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    ...(offline && { npm_config_offline: 'true' }),
  }
}

const NODE_DIR = path.dirname(process.execPath)
const DOCS = ['README.md', 'docs/architecture.md', 'LICENSE']
const HOST_PEERS = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']

test('every production module is TypeScript that owns its generated JavaScript and declaration', async () => {
  assert.ok(inventory.sources.length > 0)
  for (const dir of SOURCE_DIRS) {
    const files = (await fs.readdir(path.join(ROOT, dir), { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => `${dir}/${entry.name}`)
    // No hand-written JavaScript and no declaration left over from a removed source.
    for (const file of files) {
      assert.ok(inventory.sources.includes(file) || inventory.generated.includes(file), `${file} is neither a TypeScript source nor generated from one`)
    }
    for (const file of [...inventory.sources, ...inventory.generated].filter((file) => path.posix.dirname(file) === dir)) {
      assert.ok(files.includes(file), `${file} is missing`)
    }
  }
})

test('the tarball contains exactly the runtime files and their declarations, as tracked', async () => {
  const expected = ['bin/pi-forum', 'package.json', ...DOCS, ...inventory.generated].sort()
  const files = await listFiles(pkg)
  assert.deepEqual(files, expected)
  // Generated JavaScript and declarations ship; TypeScript sources, build tooling and tests do not.
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(\.idea|\.git|node_modules|test|scripts)(\/|$)|\.tgz$|(?<!\.d)\.ts$|\.map$|^(tsconfig|package-lock)\.json$/)
  }
  for (const file of [...DOCS, 'bin/pi-forum', ...inventory.generated]) {
    assert.deepEqual(await fs.readFile(path.join(pkg, file)), await fs.readFile(path.join(ROOT, file)), file)
  }
  assert.match(await fs.readFile(path.join(pkg, 'LICENSE'), 'utf8'), /^MIT License\n\nCopyright \(c\) \d{4} \S/)
  const runtime = ['extension/index.js', 'extension/runtime.js', 'extension/preferences.js', 'extension/output.js', 'extension/entry-renderer.js']
  for (const file of [...runtime, 'src/forum.js', 'src/backends/jsonl.js', 'src/forum.d.ts', 'src/types.d.ts', 'extension/types.d.ts']) {
    assert.ok(files.includes(file), file)
  }
})

// Relative imports must land on packaged files: declarations on declarations, JavaScript on
// JavaScript. Bare imports name only Node built-ins or the host peers, which Pi supplies.
test('the packaged modules and declarations import only packaged files, Node built-ins and the host peers', async () => {
  for (const file of inventory.generated) {
    const text = await fs.readFile(path.join(pkg, file), 'utf8')
    assert.doesNotMatch(text, /sourceMappingURL|\.ts['"]/, file)
    const specifiers = [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*'([^']+)'/g)].map((match) => match[1])
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) {
        assert.ok(specifier.startsWith('node:') || HOST_PEERS.includes(specifier), `${file} imports ${specifier}`)
        continue
      }
      assert.match(specifier, /\.js$/, `${file} imports ${specifier}`)
      const target = path.posix.join(path.posix.dirname(file), specifier)
      const resolved = file.endsWith('.d.ts') ? target.replace(/\.js$/, '.d.ts') : target
      assert.ok(inventory.generated.includes(resolved), `${file} imports ${specifier}, which is not packaged as ${resolved}`)
    }
  }
  assert.match(await fs.readFile(path.join(pkg, 'src/forum.d.ts'), 'utf8'), /export declare function createForum\(options: CreateForumOptions\): Forum;/)
  assert.match(await fs.readFile(path.join(pkg, 'extension/index.d.ts'), 'utf8'), /export default function piForum\(pi: ForumExtensionAPI\): void;/)
})

test('the packaged manifest keeps its entry points, peers and install contract', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'pi-forum')
  assert.equal(manifest.license, 'MIT')
  assert.deepEqual(manifest.bin, { 'pi-forum': 'bin/pi-forum' })
  assert.equal(manifest.type, 'module')
  assert.deepEqual(manifest.engines, { node: '>=22.19' })
  assert.deepEqual(manifest.pi, { extensions: ['./extension/index.js'] })
  assert.deepEqual(manifest.peerDependencies, { '@earendil-works/pi-coding-agent': '*', '@earendil-works/pi-tui': '*' })
  // No runtime dependencies, and modules are imported by path: no exports map or entry fields.
  for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'exports', 'main', 'types', 'typings']) {
    assert.equal(manifest[field], undefined, field)
  }
  // Installs never build: Pi installs from Git omit dev dependencies, and local loads do not install.
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, hook)
  }
  // The compiler is for contributors only; packing builds first.
  assert.equal(manifest.scripts.prepack, 'npm run build')
  assert.ok(Object.hasOwn(manifest.devDependencies, 'typescript'))
})

// The text formatter and entry renderer have no host imports, so the packaged copies load here.
test('the packaged text output and session entry renderer load from the tarball', async () => {
  const load = (file) => import(pathToFileURL(path.join(pkg, 'extension', file)).href)
  const { ENTRY_TYPE, createEntryRenderer, entryData } = await load('entry-renderer.js')
  const { LIST_PAGE_SIZE, formatTopicList } = await load('output.js')
  assert.equal(ENTRY_TYPE, 'pi-forum.output')
  assert.deepEqual(entryData('text'), { text: 'text' })
  assert.equal(LIST_PAGE_SIZE, 20)
  const text = formatTopicList({
    target: { forumDir: '/forum', generated: false, status: 'on' },
    page: { items: [{ id: 't1', title: 'Plan', created_by: 'ralph', created_at: '2026-01-01T00:00:00.000Z' }], next_cursor: 'c1' },
  })
  assert.equal(text.split('\n').at(-1), 'You are caught up.')
  class Text {
    constructor(shown, paddingX, paddingY) {
      Object.assign(this, { shown, paddingX, paddingY })
    }
  }
  const drawn = createEntryRenderer({ Text })({ type: 'custom', customType: ENTRY_TYPE, data: entryData('a\x1b[31mb\nc') }, { expanded: false }, {})
  assert.deepEqual({ ...drawn }, { shown: 'a␛[31mb\nc', paddingX: 1, paddingY: 0 })
})

// The saved-defaults store imports only Node built-ins, so the packaged copy runs here too.
test('the packaged preference store saves and resets defaults from the tarball', async () => {
  const { createPreferenceStore, PREFERENCES_FILE } = await import(pathToFileURL(path.join(pkg, 'extension', 'preferences.js')).href)
  const agentDir = path.join(temp, 'prefs-agent')
  const cwd = path.join(temp, 'prefs-project')
  const store = createPreferenceStore({ getAgentDir: () => agentDir })
  const ctx = { cwd, isProjectTrusted: () => true }
  assert.equal(PREFERENCES_FILE, 'forum.json')
  assert.deepEqual(store.set('user', true, ctx), { ok: true, scope: 'user', path: path.join(agentDir, 'forum.json'), enabled: true, changed: true })
  assert.deepEqual(store.set('project', false, ctx), { ok: true, scope: 'project', path: path.join(cwd, '.pi', 'forum.json'), enabled: false, changed: true })
  assert.deepEqual([store.load(ctx).enabled, store.load(ctx).source], [false, 'project'])
  assert.equal(store.reset('project', ctx).changed, true)
  assert.equal(await fs.readFile(path.join(cwd, '.pi', 'forum.json'), 'utf8'), '{}\n')
  assert.deepEqual([store.load(ctx).enabled, store.load(ctx).source], [true, 'user'])
  assert.equal(store.load({ cwd, isProjectTrusted: () => false }).project.ignored.code, 'untrusted')
})

test('the packaged executable has mode 0755 and a node shebang', async () => {
  const bin = path.join(pkg, 'bin', 'pi-forum')
  assert.equal((await fs.stat(bin)).mode & 0o777, 0o755)
  assert.ok((await fs.readFile(bin, 'utf8')).startsWith('#!/usr/bin/env node\n'))
})

test('the packaged executable runs by direct path, through PATH and through a symlink', async () => {
  const forumDir = path.join(temp, 'forum')
  const links = path.join(temp, 'links')
  await fs.mkdir(links)
  await fs.symlink(path.join(pkg, 'bin', 'pi-forum'), path.join(links, 'pi-forum'))
  const options = (pathDirs) => ({
    cwd: temp,
    env: { PATH: [...pathDirs, NODE_DIR].join(path.delimiter), PI_FORUM_DIR: forumDir, PI_SESSION_ID: 'pkg-session' },
  })

  const help = await exec(path.join(pkg, 'bin', 'pi-forum'), ['--help'], { cwd: temp, env: { PATH: NODE_DIR } })
  assert.match(help.stdout, /^Usage:\n {2}pi-forum topic create/)

  const created = await exec(path.join(pkg, 'bin', 'pi-forum'), ['topic', 'create', 'Packaged', '--body', 'hi'], options([]))
  const { topic, message } = JSON.parse(created.stdout)
  assert.equal(topic.created_by, 'pkg-session')
  assert.equal(message.body, 'hi')

  const viaPath = await exec('pi-forum', ['message', 'post', topic.id, '--body', 'via PATH'], options([path.join(pkg, 'bin')]))
  assert.equal(JSON.parse(viaPath.stdout).message.body, 'via PATH')

  const viaLink = await exec('pi-forum', ['message', 'list', '--topic', topic.id], options([links]))
  assert.deepEqual(JSON.parse(viaLink.stdout).items.map((m) => m.body), ['hi', 'via PATH'])
  for (const result of [help, created, viaPath, viaLink]) assert.equal(result.stderr, '')
})

// Runs an installed pi-forum executable once: creates a topic in a new forum and lists it back.
async function runInstalled(bin, label) {
  const forumDir = path.join(temp, `forum-${label}`)
  const env = { PATH: NODE_DIR, PI_FORUM_DIR: forumDir, PI_SESSION_ID: label }
  const created = await exec(bin, ['topic', 'create', label, '--body', 'installed'], { cwd: temp, env })
  assert.equal(created.stderr, '')
  const listed = await exec(bin, ['topic', 'list'], { cwd: temp, env })
  assert.deepEqual(JSON.parse(listed.stdout).items.map((t) => [t.title, t.created_by]), [[label, label]])
}

// As Pi installs an npm source: npm install <spec> --prefix <root> --legacy-peer-deps into a root
// holding only a private package.json. Peers are not installed, nothing is built, and the installed
// files are exactly those of the tarball. Real extension loading from such an install is covered
// against Pi itself in pi-integration.test.js.
test('npm installs the tarball offline as Pi installs npm packages, with no peers, dev tools or build', async () => {
  const root = path.join(temp, 'npm-root')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-extensions', private: true }, null, 2))
  await exec('npm', ['install', tarball, '--prefix', root, '--legacy-peer-deps'], { cwd: root, env: npmEnv('npm-install', { offline: true }) })
  const modules = path.join(root, 'node_modules')
  assert.deepEqual((await fs.readdir(modules)).sort(), ['.bin', '.package-lock.json', 'pi-forum'])
  assert.deepEqual(await fs.readdir(path.join(modules, '.bin')), ['pi-forum'])
  const installed = path.join(modules, 'pi-forum')
  assert.deepEqual(await listFiles(installed), await listFiles(pkg))
  for (const file of await listFiles(pkg)) {
    assert.deepEqual(await fs.readFile(path.join(installed, file)), await fs.readFile(path.join(pkg, file)), file)
  }
  await runInstalled(path.join(modules, '.bin', 'pi-forum'), 'npm-installed')
  const { formatTopicList } = await import(pathToFileURL(path.join(installed, 'extension', 'output.js')).href)
  assert.equal(typeof formatTopicList, 'function')
})

// As Pi installs a Git source: after cloning, it runs npm install --omit=dev --legacy-peer-deps in
// the checkout. A snapshot of this checkout stands in for the clone. With no runtime dependencies,
// npm installs nothing and runs no build: the tracked generated JavaScript is what loads, and every
// file is left as committed. Pi's own git install and loading are covered in pi-integration.test.js.
test('a Git checkout installs offline with npm install --omit=dev --legacy-peer-deps, unchanged and without a build', async () => {
  const checkout = path.join(temp, 'git-checkout')
  const files = await copyCheckout(checkout)
  for (const file of [...inventory.generated, 'package-lock.json']) assert.ok(files.includes(file), `${file} is not committed`)
  const committed = await snapshot(checkout, { files })
  const contents = (state) => Object.fromEntries(Object.entries(state).map(([file, { sha256, mode }]) => [file, { sha256, mode }]))
  await exec('npm', ['install', '--omit=dev', '--legacy-peer-deps'], { cwd: checkout, env: npmEnv('git-install', { offline: true }) })
  assert.deepEqual(await listFiles(checkout), files)
  assert.deepEqual(contents(await snapshot(checkout, { files })), contents(committed))
  await runInstalled(path.join(checkout, 'bin', 'pi-forum'), 'git-installed')
  const { createPreferenceStore } = await import(pathToFileURL(path.join(checkout, 'extension', 'preferences.js')).href)
  assert.equal(typeof createPreferenceStore, 'function')
})

test('packing and installing left the working tree unchanged', async () => {
  assert.deepEqual(await snapshot(ROOT, { files: await checkoutFiles() }), tree)
})
