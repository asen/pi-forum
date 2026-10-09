// Type regressions of the published declarations. A scratch consumer project installs the packed
// tarball as node_modules/pi-forum, links in this checkout's Pi 1.1.0, pi-tui and Node types, and
// compiles test/types/consumer.ts with the production compiler options. Needs the dev dependencies
// (npm ci).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { promisify } from 'node:util'
import { ROOT, generatedInventory } from './checkout.js'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
let temp
let consumer

// The checkout's compiler options, minus its file selection and emit settings.
async function compilerOptions(overrides) {
  const text = await fs.readFile(path.join(ROOT, 'tsconfig.json'), 'utf8')
  const { compilerOptions: options } = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
  for (const key of ['rootDir', 'declaration', 'noEmitOnError', 'sourceMap', 'newLine']) delete options[key]
  return { ...options, noEmit: true, ...overrides }
}

before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-types-test-'))
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: ROOT,
    env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_update_notifier: 'false' },
  })
  const [{ filename }] = JSON.parse(stdout)
  consumer = path.join(temp, 'consumer')
  const modules = path.join(consumer, 'node_modules')
  await fs.mkdir(modules, { recursive: true })
  await exec('tar', ['-xzf', path.join(temp, filename), '-C', modules])
  await fs.rename(path.join(modules, 'package'), path.join(modules, 'pi-forum'))
  for (const name of ['@earendil-works', '@types']) await fs.symlink(path.join(ROOT, 'node_modules', name), path.join(modules, name))
  await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  await fs.copyFile(path.join(ROOT, 'test', 'types', 'consumer.ts'), path.join(consumer, 'consumer.ts'))
})

after(async () => {
  if (temp) await fs.rm(temp, { recursive: true, force: true })
})

// Reads one tsc run, given as execFile reports it: { code, signal, stdout, stderr }. It must have
// run to completion and printed nothing but diagnostics (with --pretty false: one header line each,
// then any indented continuation lines), all on stdout, exiting 0 without any or 1 or 2 with some.
// Anything else (a launch failure such as EPERM, a signal, another exit code, an exit status that
// contradicts the output, or any other output) throws with the whole output, so a test cannot pass
// on a compiler that did not check. Resolves to { code, diagnostics }, each diagnostic
// { file, line, column, code, message, text }; file is null for a diagnostic without a location.
function compilerResult({ code, signal = null, stdout = '', stderr = '' }) {
  const output = `exit ${code}, signal ${signal}\n--- stdout\n${stdout}--- stderr\n${stderr}`
  if (signal !== null) throw new Error(`tsc was terminated by ${signal}\n${output}`)
  if (!Number.isInteger(code)) throw new Error(`tsc did not run: ${code}\n${output}`)
  if (stderr !== '') throw new Error(`tsc wrote to stderr\n${output}`)
  const diagnostics = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const header = /^(?:(.+)\((\d+),(\d+)\): )?error (TS\d+): (.*)$/.exec(line)
    if (header) {
      const [, file = null, row, column, diagnostic, message] = header
      diagnostics.push({ file, line: file && Number(row), column: file && Number(column), code: diagnostic, message, text: line })
    } else if (/^\s+\S/.test(line) && diagnostics.length > 0) {
      const last = diagnostics.at(-1)
      last.message += `\n${line.trim()}`
      last.text += `\n${line}`
    } else {
      throw new Error(`tsc printed something other than diagnostics: ${JSON.stringify(line)}\n${output}`)
    }
  }
  if (diagnostics.length === 0 ? code !== 0 : code !== 1 && code !== 2) {
    throw new Error(`tsc exited ${code} with ${diagnostics.length} diagnostic(s)\n${output}`)
  }
  return { code, diagnostics }
}

// Runs this checkout's tsc on a consumer project; resolves to compilerResult() of the run.
async function tsc(project) {
  const manifest = require.resolve('typescript/package.json')
  const bin = path.join(path.dirname(manifest), require(manifest).bin.tsc)
  const run = await exec(process.execPath, [bin, '-p', project, '--pretty', 'false'], { cwd: consumer }).then(
    (done) => ({ code: 0, signal: null, ...done }),
    (err) => ({ code: err.code, signal: err.signal ?? null, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  )
  return compilerResult(run)
}

// The diagnostics Pi 1.1.0's own declarations report under NodeNext without skipLibCheck, which is
// why tsconfig.json skips library checks. A path is matched from its last node_modules/ on.
const GENAI = /^@google\/genai\/dist\/node\/node\.d\.ts$/
const VENDOR_DIAGNOSTICS = [
  // pi-ai imports its model tables as JSON without a type attribute.
  {
    file: /^@earendil-works\/pi-ai\/dist\/providers\/[\w.-]+\.models\.d\.ts$/,
    code: /^TS1543$/,
    message: /^Importing a JSON file into an ECMAScript module requires a 'type: "json"' import attribute/,
  },
  // @google/genai imports the optional MCP SDK, which is not installed...
  { file: GENAI, code: /^TS2307$/, message: /^Cannot find module '@modelcontextprotocol\/sdk\// },
  // ...and names DOM types that Node's types do not declare.
  { file: GENAI, code: /^TS(2304|2552)$/, message: /^Cannot find name '(RequestInfo|ErrorEvent|CloseEvent|HeadersInit)'\./ },
]

function isVendorDiagnostic({ file, code, message }) {
  const at = file?.lastIndexOf('node_modules/') ?? -1
  if (at < 0) return false
  const vendored = file.slice(at + 'node_modules/'.length)
  return VENDOR_DIAGNOSTICS.some((known) => known.file.test(vendored) && known.code.test(code) && known.message.test(message))
}

async function writeProject(name, options, files) {
  const project = path.join(consumer, name)
  await fs.writeFile(project, JSON.stringify({ compilerOptions: await compilerOptions(options), files }, null, 2))
  return project
}

test('public Forum, adapter, event, view and Pi types accept valid uses and reject invalid ones', async () => {
  const result = await tsc(await writeProject('tsconfig.json', {}, ['consumer.ts']))
  assert.deepEqual(result, { code: 0, diagnostics: [] })
  // The fixture compiled against the packed declarations, not the TypeScript sources.
  await assert.rejects(fs.access(path.join(consumer, 'node_modules', 'pi-forum', 'src', 'forum.ts')))
})

// The control: without its directives, the fixture fails exactly on each line one marked.
test('each rejection in the fixture is a type error on the line it marks', async () => {
  const lines = (await fs.readFile(path.join(consumer, 'consumer.ts'), 'utf8')).split('\n')
  const marked = lines.flatMap((line, i) => (line.trim().startsWith('// @ts-expect-error') ? [i + 2] : []))
  assert.ok(marked.length >= 15, `${marked.length} rejections`)
  const unmarked = lines.map((line) => (line.trim().startsWith('// @ts-expect-error') ? '//' : line))
  await fs.writeFile(path.join(consumer, 'unmarked.ts'), unmarked.join('\n'))
  const result = await tsc(await writeProject('tsconfig.unmarked.json', {}, ['unmarked.ts']))
  const texts = result.diagnostics.map((diagnostic) => diagnostic.text).join('\n')
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.file === 'unmarked.ts'), texts)
  assert.deepEqual([...new Set(result.diagnostics.map((diagnostic) => diagnostic.line))], marked, texts)
})

// skipLibCheck covers only vendor declarations that do not check on their own (see tsconfig.json).
// Without it, the published declarations themselves must report nothing.
test('the published declarations check cleanly without skipLibCheck', async () => {
  const { generated } = await generatedInventory()
  const declarations = generated.filter((file) => file.endsWith('.d.ts')).map((file) => `node_modules/pi-forum/${file}`)
  const result = await tsc(await writeProject('tsconfig.lib.json', { skipLibCheck: false }, declarations))
  const texts = (diagnostics) => diagnostics.map((diagnostic) => diagnostic.text)
  assert.deepEqual(texts(result.diagnostics.filter((diagnostic) => diagnostic.file?.startsWith('node_modules/pi-forum/'))), [])
  // The rest are exactly the known vendor errors. They also show that library files were checked; if
  // a Pi update fixes them, skipLibCheck can go.
  assert.deepEqual(texts(result.diagnostics.filter((diagnostic) => !isVendorDiagnostic(diagnostic))), [])
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'TS1543'), 'no vendor diagnostics: were library files checked?')
})

// The compiler-result reader itself, on runs the real compiler is not made to produce.
const DIAGNOSTIC = "consumer.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'."

test('a tsc run that did not complete is never read as a result', () => {
  assert.throws(() => compilerResult({ code: 'EPERM', signal: null, stdout: '', stderr: '' }), /^Error: tsc did not run: EPERM\n/)
  assert.throws(() => compilerResult({ code: 'ENOENT' }), /tsc did not run: ENOENT/)
  assert.throws(() => compilerResult({ code: null, signal: 'SIGKILL', stdout: '', stderr: '' }), /^Error: tsc was terminated by SIGKILL\n/)
  assert.throws(() => compilerResult({ code: null, signal: 'SIGTERM', stdout: `${DIAGNOSTIC}\n` }), /terminated by SIGTERM/)
  assert.throws(() => compilerResult({ code: undefined }), /tsc did not run: undefined/)
})

test('a tsc exit status must agree with its diagnostics', () => {
  assert.throws(() => compilerResult({ code: 1, stdout: '', stderr: '' }), /^Error: tsc exited 1 with 0 diagnostic\(s\)\n/)
  assert.throws(() => compilerResult({ code: 2, stdout: '\n' }), /tsc exited 2 with 0 diagnostic/)
  assert.throws(() => compilerResult({ code: 0, stdout: `${DIAGNOSTIC}\n` }), /tsc exited 0 with 1 diagnostic/)
  assert.throws(() => compilerResult({ code: 3, stdout: `${DIAGNOSTIC}\n` }), /tsc exited 3 with 1 diagnostic/)
})

test('output from tsc other than diagnostics fails, and is kept in the error', () => {
  for (const run of [
    { code: 0, stdout: 'Segmentation fault\n' },
    { code: 2, stdout: `${DIAGNOSTIC}\nFound 1 error.\n` },
    { code: 1, stdout: '  an indented line before any diagnostic\n' },
    { code: 0, stdout: '', stderr: 'warning: something\n' },
    { code: 2, stdout: `${DIAGNOSTIC}\n`, stderr: 'warning: something\n' },
  ]) {
    assert.throws(
      () => compilerResult(run),
      (err) => err.message.includes(`--- stdout\n${run.stdout}--- stderr\n${run.stderr ?? ''}`),
      JSON.stringify(run),
    )
  }
})

test('diagnostics are read with their location, code, continuation lines and global form', () => {
  assert.deepEqual(compilerResult({ code: 0, signal: null, stdout: '', stderr: '' }), { code: 0, diagnostics: [] })
  const stdout = `${DIAGNOSTIC}\n  Types of property 'a' are incompatible.\nerror TS5023: Unknown compiler option 'bogus'.\n`
  assert.deepEqual(compilerResult({ code: 1, stdout }), {
    code: 1,
    diagnostics: [
      {
        file: 'consumer.ts',
        line: 3,
        column: 7,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.\nTypes of property 'a' are incompatible.",
        text: `${DIAGNOSTIC}\n  Types of property 'a' are incompatible.`,
      },
      { file: null, line: null, column: null, code: 'TS5023', message: "Unknown compiler option 'bogus'.", text: "error TS5023: Unknown compiler option 'bogus'." },
    ],
  })
})

test('only the known vendor diagnostics are allowed in the declaration check', () => {
  const diagnostic = (file, code, message) => compilerResult({ code: 2, stdout: `${file}(1,1): error ${code}: ${message}\n` }).diagnostics[0]
  const vendor = '../../../repo/node_modules/'
  const json = `Importing a JSON file into an ECMAScript module requires a 'type: "json"' import attribute when 'module' is set to 'NodeNext'.`
  for (const allowed of [
    diagnostic(`${vendor}@earendil-works/pi-ai/dist/providers/openai.models.d.ts`, 'TS1543', json),
    diagnostic(`${vendor}@google/genai/dist/node/node.d.ts`, 'TS2307', "Cannot find module '@modelcontextprotocol/sdk/client/index.js' or its corresponding type declarations."),
    diagnostic(`${vendor}@google/genai/dist/node/node.d.ts`, 'TS2552', "Cannot find name 'ErrorEvent'. Did you mean 'ErrorEvent$'?"),
    diagnostic(`${vendor}@google/genai/dist/node/node.d.ts`, 'TS2304', "Cannot find name 'HeadersInit'."),
  ]) {
    assert.equal(isVendorDiagnostic(allowed), true, allowed.text)
  }
  for (const rejected of [
    diagnostic('node_modules/pi-forum/src/cursor.d.ts', 'TS2304', "Cannot find name 'Missing'."),
    diagnostic(`${vendor}@earendil-works/pi-ai/dist/providers/openai.models.d.ts`, 'TS2304', "Cannot find name 'Model'."),
    diagnostic(`${vendor}@earendil-works/pi-ai/dist/index.d.ts`, 'TS1543', json),
    diagnostic(`${vendor}@google/genai/dist/node/node.d.ts`, 'TS2304', "Cannot find name 'Forum'."),
    diagnostic(`${vendor}@google/genai/dist/node/node.d.ts`, 'TS2307', "Cannot find module 'pi-forum/src/forum.js' or its corresponding type declarations."),
    diagnostic(`${vendor}@earendil-works/pi-coding-agent/dist/index.d.ts`, 'TS2307', "Cannot find module '@modelcontextprotocol/sdk/client/index.js'."),
  ]) {
    assert.equal(isVendorDiagnostic(rejected), false, rejected.text)
  }
  assert.equal(isVendorDiagnostic({ file: null, code: 'TS1543', message: json }), false)
})
