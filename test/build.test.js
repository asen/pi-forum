// Regression tests for scripts/build.mjs, behind npm run build, npm run check-generated and npm's
// prepack. Each test works in its own scratch copy of the checkout (as Git would clone it, with the
// checkout's node_modules linked in for the compiler and the host types), so the working tree is
// never built, packed or otherwise written. They need the dev dependencies installed (npm ci).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import { ROOT, copyCheckout, generatedInventory, listFiles, snapshot } from './checkout.js'

const exec = promisify(execFile)
const SKIP = ['node_modules', '.git']
let temp
let inventory
let copies = 0

before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-build-test-'))
  inventory = await generatedInventory()
  assert.ok(inventory.sources.length > 0)
})

after(async () => {
  if (temp) await fs.rm(temp, { recursive: true, force: true })
})

// A scratch copy of the checkout with its own temp directory, where the build stages its output.
async function scratch() {
  const dir = path.join(temp, `copy-${++copies}`)
  await copyCheckout(dir)
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'))
  const tmp = path.join(temp, `tmp-${copies}`)
  await fs.mkdir(tmp)
  return { dir, tmp }
}

// Runs scripts/build.mjs of a copy; resolves to its exit code, stdout and stderr lines.
async function build({ dir, tmp }, args = []) {
  const options = { cwd: dir, env: { ...process.env, TMPDIR: tmp } }
  const result = await exec(process.execPath, [path.join(dir, 'scripts', 'build.mjs'), ...args], options).then(
    (done) => ({ code: 0, ...done }),
    (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr }),
  )
  assert.equal(typeof result.code, 'number', `build did not run: ${result.stderr}`)
  // The staging directory is always removed.
  assert.deepEqual(await fs.readdir(tmp), [])
  return { code: result.code, stdout: result.stdout, lines: result.stderr.split('\n').filter(Boolean) }
}

const summary = (name, done) =>
  `${name}: ${inventory.generated.length} generated file(s) from ${inventory.sources.length} source(s) ${done}`
const original = (file) => fs.readFile(path.join(ROOT, file))

// Removes two generated files and edits two others, one of each kind.
async function damage(dir) {
  await fs.rm(path.join(dir, 'src/cursor.js'))
  await fs.rm(path.join(dir, 'extension/output.d.ts'))
  await fs.appendFile(path.join(dir, 'src/forum.js'), '// edited by hand\n')
  await fs.writeFile(path.join(dir, 'extension/types.d.ts'), (await original('extension/types.d.ts')).toString().replace('export type', 'export  type'))
}
const DAMAGED = ['extension/output.d.ts', 'extension/types.d.ts', 'src/cursor.js', 'src/forum.js']

test('check-generated passes on a clean copy and writes nothing', async () => {
  const copy = await scratch()
  const before = await snapshot(copy.dir, { skip: SKIP })
  const result = await build(copy, ['--check'])
  assert.deepEqual(result, { code: 0, stdout: '', lines: [summary('check-generated', 'are current')] })
  assert.deepEqual(await snapshot(copy.dir, { skip: SKIP }), before)
})

test('check-generated reports missing, edited and orphaned output, read-only', async () => {
  const copy = await scratch()
  await damage(copy.dir)
  await fs.writeFile(path.join(copy.dir, 'src/orphan.d.ts'), 'export declare const orphan: number;\n')
  const before = await snapshot(copy.dir, { skip: SKIP })
  const result = await build(copy, ['--check'])
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    lines: [
      'check-generated: src/orphan.d.ts has no TypeScript source; remove it and its JavaScript if the source was removed',
      'check-generated: extension/output.d.ts is missing',
      'check-generated: extension/types.d.ts differs from the build',
      'check-generated: src/cursor.js is missing',
      'check-generated: src/forum.js differs from the build',
      'check-generated: run npm run build and commit the generated files',
    ],
  })
  assert.deepEqual(await snapshot(copy.dir, { skip: SKIP }), before)
})

test('build rewrites exactly the missing and edited output, byte for byte, and then nothing', async () => {
  const copy = await scratch()
  await damage(copy.dir)
  const before = await snapshot(copy.dir, { skip: SKIP })
  const result = await build(copy)
  assert.deepEqual(result, { code: 0, stdout: '', lines: [...DAMAGED.map((file) => `build: wrote ${file}`), summary('build', 'are up to date')] })
  const afterBuild = await snapshot(copy.dir, { skip: SKIP })
  for (const file of Object.keys(before)) {
    if (DAMAGED.includes(file)) assert.ok(afterBuild[file], file)
    else assert.deepEqual(afterBuild[file], before[file], `${file} was rewritten`)
  }
  for (const file of DAMAGED) assert.deepEqual(await fs.readFile(path.join(copy.dir, file)), await original(file), file)
  assert.deepEqual(Object.keys(afterBuild), [...new Set([...Object.keys(before), ...DAMAGED])].sort())

  // Built output is current, and building again writes nothing.
  assert.deepEqual(await build(copy, ['--check']), { code: 0, stdout: '', lines: [summary('check-generated', 'are current')] })
  assert.deepEqual(await build(copy), { code: 0, stdout: '', lines: [summary('build', 'are up to date')] })
  assert.deepEqual(await snapshot(copy.dir, { skip: SKIP }), afterBuild)
})

test('build reports an orphaned declaration and never deletes it', async () => {
  const copy = await scratch()
  const orphan = 'export declare const orphan: number;\n'
  await fs.writeFile(path.join(copy.dir, 'src/orphan.d.ts'), orphan)
  await fs.appendFile(path.join(copy.dir, 'src/forum.js'), '// edited by hand\n')
  const result = await build(copy)
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    lines: ['build: wrote src/forum.js', 'build: src/orphan.d.ts has no TypeScript source; remove it and its JavaScript if the source was removed'],
  })
  assert.equal(await fs.readFile(path.join(copy.dir, 'src/orphan.d.ts'), 'utf8'), orphan)
  assert.deepEqual(await fs.readFile(path.join(copy.dir, 'src/forum.js')), await original('src/forum.js'))
})

test('a compile error fails build and check-generated without writing any file', async () => {
  const copy = await scratch()
  await damage(copy.dir)
  await fs.appendFile(path.join(copy.dir, 'src/cursor.ts'), "\nexport const broken: number = 'not a number'\n")
  const before = await snapshot(copy.dir, { skip: SKIP })
  for (const [args, name] of [[[], 'build'], [['--check'], 'check-generated']]) {
    const result = await build(copy, args)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.ok(result.lines.some((line) => /^src\/cursor\.ts\(\d+,\d+\): error TS2322:/.test(line)), result.lines.join('\n'))
    assert.equal(result.lines.at(-1), `${name}: tsc failed; no generated file was changed`)
    // Nothing was written: removed output is still missing and edited output still edited.
    assert.deepEqual(await snapshot(copy.dir, { skip: SKIP }), before)
  }
})

test('build regenerates every output deterministically, identical to the tracked files', async () => {
  const copies = [await scratch(), await scratch()]
  const outputs = []
  for (const copy of copies) {
    for (const file of inventory.generated) await fs.rm(path.join(copy.dir, file))
    assert.deepEqual(await build(copy, ['--check']), {
      code: 1,
      stdout: '',
      lines: [...inventory.generated.map((file) => `check-generated: ${file} is missing`), 'check-generated: run npm run build and commit the generated files'],
    })
    const result = await build(copy)
    assert.deepEqual(result, { code: 0, stdout: '', lines: [...inventory.generated.map((file) => `build: wrote ${file}`), summary('build', 'are up to date')] })
    outputs.push(await Promise.all(inventory.generated.map((file) => fs.readFile(path.join(copy.dir, file)))))
  }
  for (const [i, file] of inventory.generated.entries()) {
    assert.deepEqual(outputs[0][i], outputs[1][i], file)
    assert.deepEqual(outputs[0][i], await original(file), file)
  }
})

test('an unknown argument is a usage error and writes nothing', async () => {
  const copy = await scratch()
  await fs.rm(path.join(copy.dir, 'src/cursor.js'))
  const before = await snapshot(copy.dir, { skip: SKIP })
  for (const args of [['--bogus'], ['--check', '--check']]) {
    assert.deepEqual(await build(copy, args), { code: 2, stdout: '', lines: ['Usage: node scripts/build.mjs [--check]'] })
  }
  assert.deepEqual(await snapshot(copy.dir, { skip: SKIP }), before)
})

// The contributor path: npm pack runs prepack, whose build output goes to stderr, so stdout stays the
// JSON that npm pack --json prints, and the tarball holds the rebuilt files.
test('npm pack builds through prepack and keeps its JSON output parseable', async () => {
  const copy = await scratch()
  await damage(copy.dir)
  const unpacked = await listFiles(copy.dir, { skip: SKIP })
  const env = { ...process.env, TMPDIR: copy.tmp, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_update_notifier: 'false' }
  const out = path.join(temp, 'packed')
  await fs.mkdir(out)
  const { stdout, stderr } = await exec('npm', ['pack', '--json', '--pack-destination', out], { cwd: copy.dir, env })
  const [{ filename, files }] = JSON.parse(stdout)
  assert.match(stderr, new RegExp(`build: wrote src/forum\\.js\\n[^]*${summary('build', 'are up to date').replace(/[()]/g, '\\$&')}`))
  for (const file of DAMAGED) assert.ok(files.some((entry) => entry.path === file), file)
  const extracted = path.join(temp, 'packed-extracted')
  await fs.mkdir(extracted)
  await exec('tar', ['-xzf', path.join(out, filename), '-C', extracted])
  for (const file of DAMAGED) assert.deepEqual(await fs.readFile(path.join(extracted, 'package', file)), await original(file), file)
  // npm keeps its own compile cache there; the build's staging directory is gone.
  assert.deepEqual((await fs.readdir(copy.tmp)).filter((name) => name.startsWith('pi-forum-build-')), [])
  // The build ran in the scratch copy, restoring its removed files and adding nothing else.
  assert.deepEqual(await listFiles(copy.dir, { skip: SKIP }), [...unpacked, 'extension/output.d.ts', 'src/cursor.js'].sort())
  for (const file of DAMAGED) assert.deepEqual(await fs.readFile(path.join(copy.dir, file)), await original(file), file)
})
