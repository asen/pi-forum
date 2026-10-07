import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
let temp
let pkg

// Packs the working tree with npm and extracts the tarball, as an installer would see it.
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-package-test-'))
  const env = { ...process.env, npm_config_cache: path.join(temp, 'npm-cache') }
  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', temp], { cwd: ROOT, env })
  const [{ filename }] = JSON.parse(stdout)
  const extracted = path.join(temp, 'extracted')
  await fs.mkdir(extracted)
  await exec('tar', ['-xzf', path.join(temp, filename), '-C', extracted])
  pkg = path.join(extracted, 'package')
})

after(async () => {
  if (temp) await fs.rm(temp, { recursive: true, force: true })
})

async function listFiles(dir, prefix = '') {
  const files = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(dir, entry.name), name)))
    else files.push(name)
  }
  return files.sort()
}

const NODE_DIR = path.dirname(process.execPath)

test('the tarball contains exactly the runtime files', async () => {
  const jsFiles = async (dir) =>
    (await fs.readdir(path.join(ROOT, dir))).filter((name) => name.endsWith('.js')).map((name) => `${dir}/${name}`)
  const docs = ['README.md', 'docs/architecture.md', 'LICENSE']
  const expected = ['bin/pi-forum', 'package.json', ...docs, ...(await jsFiles('src')), ...(await jsFiles('extension'))].sort()
  const files = await listFiles(pkg)
  assert.deepEqual(files, expected)
  for (const file of files) assert.doesNotMatch(file, /(^|\/)(\.idea|\.git|node_modules|test)(\/|$)|\.tgz$/)
  for (const doc of docs) {
    assert.equal(await fs.readFile(path.join(pkg, doc), 'utf8'), await fs.readFile(path.join(ROOT, doc), 'utf8'))
  }
  assert.match(await fs.readFile(path.join(pkg, 'LICENSE'), 'utf8'), /^MIT License\n\nCopyright \(c\) \d{4} \S/)
  const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8'))
  assert.equal(manifest.license, 'MIT')
  assert.deepEqual(manifest.bin, { 'pi-forum': 'bin/pi-forum' })
  assert.equal(manifest.type, 'module')
  assert.deepEqual(manifest.engines, { node: '>=22.19' })
  assert.equal(manifest.dependencies, undefined)
  assert.deepEqual(manifest.pi, { extensions: ['./extension/index.js'] })
  assert.deepEqual(manifest.peerDependencies, { '@earendil-works/pi-coding-agent': '*' })
  assert.ok(files.includes('extension/index.js'))
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
