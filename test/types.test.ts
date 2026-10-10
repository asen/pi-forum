// Type regressions of the published types, and the contract between the core's JavaScript and its
// declarations. A scratch consumer project installs the packed tarball as node_modules/pi-forum,
// links in this checkout's Pi 1.1.0, pi-tui and Node types, and compiles test/types/consumer.ts with
// the production compiler options but without allowJs, as a TypeScript consumer would: the core's
// types come from its .d.mts sidecars, the extension's from its TypeScript. The sidecars are also
// checked on their own, and against the bodies they declare. Needs the dev dependencies (npm ci).
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import type { ExecFileException } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { ROOT, checkoutFiles, copyCheckout, listFiles, snapshot, sourceInventory } from './checkout.ts'
import type { Inventory, Snapshot } from './checkout.ts'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
let temp: string
let consumer: string
// The packed package, installed in the consumer project, and its sources by kind.
let installed: string
let packed: Inventory
let tree: Snapshot

// Compiler options as a tsconfig.json holds them.
type CompilerOptions = Record<string, unknown>

// One tsc run as execFile reports it. code is the exit status, or for a run that never started the
// error code execFile gives instead (such as 'EPERM'). The reader's own tests also pass runs with a
// missing or null code, which it must refuse.
interface CompilerRun {
  code: ExecFileException['code']
  signal?: NodeJS.Signals | null
  stdout?: string
  stderr?: string
}

// One diagnostic tsc printed; file, line and column are null for one without a location.
interface Diagnostic {
  file: string | null
  line: number | null
  column: number | null
  code: string
  message: string
  text: string
}

interface CompilerResult {
  code: number
  diagnostics: Diagnostic[]
}

// What execFile rejects with: a run that failed to start or exited nonzero, with what it printed.
type ExecFailure = ExecFileException & { stdout?: string; stderr?: string }

// The checkout's compiler options for a TypeScript consumer: minus its file selection, emit settings
// and JavaScript support, so nothing is ever typed by inferring JavaScript.
async function compilerOptions(overrides: CompilerOptions): Promise<CompilerOptions> {
  const text = await fs.readFile(path.join(ROOT, 'tsconfig.json'), 'utf8')
  const { compilerOptions: options } = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { compilerOptions: CompilerOptions }
  for (const key of ['rootDir', 'declaration', 'noEmitOnError', 'sourceMap', 'newLine', 'checkJs']) delete options[key]
  return { ...options, allowJs: false, noEmit: true, ...overrides }
}

// Packs the checkout with a plain npm pack, offline: the package has no lifecycle script to skip.
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-types-test-'))
  tree = await snapshot(ROOT, { files: await checkoutFiles() })
  const { stdout } = await exec('npm', ['pack', '--json', '--pack-destination', temp], {
    cwd: ROOT,
    env: { ...process.env, npm_config_cache: path.join(temp, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_offline: 'true' },
  })
  const [{ filename }] = JSON.parse(stdout) as [{ filename: string }]
  consumer = path.join(temp, 'consumer')
  const modules = path.join(consumer, 'node_modules')
  await fs.mkdir(modules, { recursive: true })
  await exec('tar', ['-xzf', path.join(temp, filename), '-C', modules])
  installed = path.join(modules, 'pi-forum')
  await fs.rename(path.join(modules, 'package'), installed)
  packed = await sourceInventory(installed)
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
function compilerResult({ code, signal = null, stdout = '', stderr = '' }: CompilerRun): CompilerResult {
  const output = `exit ${code}, signal ${signal}\n--- stdout\n${stdout}--- stderr\n${stderr}`
  if (signal !== null) throw new Error(`tsc was terminated by ${signal}\n${output}`)
  if (typeof code !== 'number' || !Number.isInteger(code)) throw new Error(`tsc did not run: ${code}\n${output}`)
  if (stderr !== '') throw new Error(`tsc wrote to stderr\n${output}`)
  const diagnostics: Diagnostic[] = []
  for (const line of stdout.split('\n')) {
    if (line === '') continue
    const header = /^(?:(.+)\((\d+),(\d+)\): )?error (TS\d+): (.*)$/.exec(line)
    if (header) {
      // The location's three groups match together or not at all; the code and message always match.
      const [, file = null, row, column, diagnostic, message] = header
      diagnostics.push({ file, line: file === null ? null : Number(row), column: file === null ? null : Number(column), code: diagnostic!, message: message!, text: line })
    } else if (/^\s+\S/.test(line) && diagnostics.length > 0) {
      const last = diagnostics.at(-1)!
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

// This checkout's tsc, run by Node.
function tscBin(): string {
  const manifest = require.resolve('typescript/package.json')
  return path.join(path.dirname(manifest), (require(manifest) as { bin: { tsc: string } }).bin.tsc)
}

// Runs tsc on a project, from cwd (the consumer project unless given), where diagnostics name their
// files relative to it; resolves to compilerResult() of the run.
async function tsc(project: string, cwd = consumer): Promise<CompilerResult> {
  const run = await exec(process.execPath, [tscBin(), '-p', project, '--pretty', 'false'], { cwd }).then(
    (done): CompilerRun => ({ code: 0, signal: null, ...done }),
    (err: ExecFailure): CompilerRun => ({ code: err.code, signal: err.signal ?? null, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
  )
  return compilerResult(run)
}

// The files tsc reads for a project, absolute and real, from --listFilesOnly (which checks nothing).
async function programFiles(project: string): Promise<string[]> {
  const { stdout, stderr } = await exec(process.execPath, [tscBin(), '-p', project, '--listFilesOnly'], { cwd: path.dirname(project) })
  assert.equal(stderr, '')
  const files = stdout.split('\n').filter(Boolean)
  for (const file of files) assert.ok(path.isAbsolute(file), `tsc listed ${JSON.stringify(file)}`)
  return files
}

// The packed package's files among them, relative to the package.
async function packageFiles(project: string): Promise<string[]> {
  const root = `${await fs.realpath(installed)}/`
  return (await programFiles(project)).filter((file) => file.startsWith(root)).map((file) => file.slice(root.length)).sort()
}

// The diagnostics Pi 1.1.0's own declarations report under NodeNext without skipLibCheck, which is
// why tsconfig.json skips library checks. A path is matched from its last node_modules/ on.
const GENAI = /^@google\/genai\/dist\/node\/node\.d\.ts$/
const VENDOR_DIAGNOSTICS: { file: RegExp; code: RegExp; message: RegExp }[] = [
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

function isVendorDiagnostic({ file, code, message }: Pick<Diagnostic, 'file' | 'code' | 'message'>): boolean {
  const at = file?.lastIndexOf('node_modules/') ?? -1
  if (file === null || at < 0) return false
  const vendored = file.slice(at + 'node_modules/'.length)
  return VENDOR_DIAGNOSTICS.some((known) => known.file.test(vendored) && known.code.test(code) && known.message.test(message))
}

async function writeProject(name: string, options: CompilerOptions, files: readonly string[], dir = consumer): Promise<string> {
  const project = path.join(dir, name)
  await fs.writeFile(project, JSON.stringify({ compilerOptions: await compilerOptions(options), files }, null, 2))
  return project
}

const texts = (diagnostics: readonly Diagnostic[]) => diagnostics.map((diagnostic) => diagnostic.text)

test('public Forum, adapter, event, view, record, cursor, CLI and Pi types accept valid uses and reject invalid ones', async () => {
  const project = await writeProject('tsconfig.json', {}, ['consumer.ts'])
  const result = await tsc(project)
  assert.deepEqual(result, { code: 0, diagnostics: [] })
  // The fixture compiled against the packed package, typed by every sidecar and the extension's
  // TypeScript, and no JavaScript: allowJs is off, so a module without its sidecar would not type.
  assert.deepEqual(await packageFiles(project), [...packed.sidecars, ...packed.extension].sort())
  assert.ok(packed.sidecars.length >= 7 && packed.extension.length >= 8, `${packed.sidecars.length} sidecars, ${packed.extension.length} extension modules`)
})

// The control: a core module whose sidecar is missing does not type for such a consumer, rather than
// typing as whatever its JavaScript would infer.
test('without its sidecar, a core module is an error for a consumer, never inferred from its JavaScript', async () => {
  const dir = path.join(temp, 'no-sidecar')
  const copy = path.join(dir, 'node_modules', 'pi-forum')
  await fs.mkdir(path.dirname(copy), { recursive: true })
  await fs.cp(installed, copy, { recursive: true })
  await fs.rm(path.join(copy, 'src', 'cursor.d.mts'))
  await fs.symlink(path.join(ROOT, 'node_modules', '@types'), path.join(dir, 'node_modules', '@types'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  await fs.writeFile(path.join(dir, 'uses-cursor.ts'), "import { encodeCursor } from 'pi-forum/src/cursor.mjs'\nexport const cursor: string = encodeCursor('forum', 0)\n")
  const result = await tsc(await writeProject('tsconfig.json', {}, ['uses-cursor.ts'], dir), dir)
  assert.deepEqual(
    result.diagnostics.map(({ file, line, code }) => [file, line, code]),
    [['uses-cursor.ts', 1, 'TS7016']],
    texts(result.diagnostics).join('\n'),
  )
  assert.match(result.diagnostics[0]!.message, /^Could not find a declaration file for module 'pi-forum\/src\/cursor\.mjs'/)
})

// The control: without its directives, the fixture fails exactly on each line one marked.
test('each rejection in the fixture is a type error on the line it marks', async () => {
  const lines = (await fs.readFile(path.join(consumer, 'consumer.ts'), 'utf8')).split('\n')
  const marked = lines.flatMap((line, i) => (line.trim().startsWith('// @ts-expect-error') ? [i + 2] : []))
  assert.ok(marked.length >= 30, `${marked.length} rejections`)
  const unmarked = lines.map((line) => (line.trim().startsWith('// @ts-expect-error') ? '//' : line))
  await fs.writeFile(path.join(consumer, 'unmarked.ts'), unmarked.join('\n'))
  const result = await tsc(await writeProject('tsconfig.unmarked.json', {}, ['unmarked.ts']))
  const shown = texts(result.diagnostics).join('\n')
  assert.ok(result.diagnostics.every((diagnostic) => diagnostic.file === 'unmarked.ts'), shown)
  assert.deepEqual([...new Set(result.diagnostics.map((diagnostic) => diagnostic.line))], marked, shown)
})

// The core's declarations need nothing but Node's types. Checked alone, without skipLibCheck, they
// must report nothing at all: no host declaration is even read, so none of its errors can stand in.
test('the packed core declarations check cleanly on their own without skipLibCheck', async () => {
  const project = await writeProject('tsconfig.core.json', { skipLibCheck: false }, packed.sidecars.map((file) => `node_modules/pi-forum/${file}`))
  assert.deepEqual(await tsc(project), { code: 0, diagnostics: [] })
  const files = await programFiles(project)
  assert.deepEqual(await packageFiles(project), packed.sidecars)
  assert.deepEqual(files.filter((file) => file.includes('/@earendil-works/')), [])
  assert.ok(files.some((file) => file.includes('/@types/node/')), 'Node types were not read')
})

// skipLibCheck covers only vendor declarations that do not check on their own (see tsconfig.json).
// Without it, the whole package as the fixture uses it, extension and Pi's types included, must
// report nothing of its own.
test('the packed package checks without skipLibCheck, but for the known vendor diagnostics', async () => {
  const result = await tsc(await writeProject('tsconfig.lib.json', { skipLibCheck: false }, ['consumer.ts']))
  assert.deepEqual(texts(result.diagnostics.filter((diagnostic) => !diagnostic.file?.includes('node_modules/@'))), [])
  // The rest are exactly the known vendor errors. They also show that library files were checked; if
  // a Pi update fixes them, skipLibCheck can go.
  assert.deepEqual(texts(result.diagnostics.filter((diagnostic) => !isVendorDiagnostic(diagnostic))), [])
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'TS1543'), 'no vendor diagnostics: were library files checked?')
})

// The contract between each core module's JavaScript and its sidecar, which nothing else ties
// together: inside the checkout, an import of X.mjs is typed by X.d.mts wherever one exists, so a
// body is checked against the sidecars of the modules it imports but never against its own.
//
// tsc infers each body's declaration on its own (from its JSDoc, as checkJs checks it), emitted into
// a scratch directory; nothing is emitted next to the sources. A generated program then compares,
// for every name the module exports at run time (imported with Node), the body's declared type with
// the sidecar's: the export names must match on both sides, the types must be identical, and each
// must be assignable to the other. The bodies take their public shapes as type-only imports from
// the sidecars (records, cursor and cli) and types.d.mts, so in the emitted declarations those
// imports are pointed at the authored files; their imports of other core modules stay on the
// emitted declarations, so a body's re-export is the body's. Neither side may be any. Every core
// module is an explicit root: a glob matching both X.mjs and X.d.mts would make tsc drop the module
// (see tsconfig.json).
//
// One difference is declared rather than implemented: ForumError's topic, which the sidecar declares
// optional and a partial write sets on the error it throws. For a sidecar-only member, the class is
// compared without it (its constructor, its instance and static members), and it must still be absent
// from the body.
const SIDECAR_ONLY_MEMBERS: Readonly<Record<string, readonly string[]>> = { ForumError: ['topic'] }

// One failed part of the contract: what was checked (the module and export, or the compiler step),
// and what tsc reported.
interface ContractProblem {
  check: string
  text: string
}

interface ContractResult {
  problems: ContractProblem[]
  // The checks the generated program made, by name.
  checks: string[]
}

// Points a generated file's relative specifiers at what they name, given the directory it stands for
// (dir) and the one it is in (at): declarations at the authored files under dir, modules at their
// emitted declarations, which must exist. Anything else is a problem.
async function retarget(text: string, dir: string, at: string, emitted: ReadonlySet<string>, problems: ContractProblem[], file: string): Promise<string> {
  const replacements = new Map<string, string>()
  for (const [, , specifier] of text.matchAll(/(['"])(\.\.?\/[^'"]*)\1/g)) {
    if (replacements.has(specifier!)) continue
    if (specifier!.endsWith('.d.mts')) {
      const target = path.resolve(dir, specifier!)
      if (!(await fs.access(target).then(() => true, () => false))) problems.push({ check: 'emit', text: `${file} names ${specifier}, which does not exist` })
      const relative = path.relative(at, target).split(path.sep).join('/')
      replacements.set(specifier!, relative.startsWith('.') ? relative : `./${relative}`)
    } else if (specifier!.endsWith('.mjs')) {
      const target = path.resolve(at, specifier!.replace(/\.mjs$/, '.d.mts'))
      if (!emitted.has(target)) problems.push({ check: 'emit', text: `${file} names ${specifier}, which is not a core module` })
    } else {
      problems.push({ check: 'emit', text: `${file} names ${specifier}` })
    }
  }
  return text.replace(/(['"])(\.\.?\/[^'"]*)\1/g, (match, quote: string, specifier: string) => {
    const replacement = replacements.get(specifier)
    return replacement === undefined ? match : `${quote}${replacement}${quote}`
  })
}

// Checks every core module of the tree at root against its sidecar, working in work (a new
// directory). root needs this checkout's node_modules (for Node's types).
async function contractCheck(root: string, work: string): Promise<ContractResult> {
  const problems: ContractProblem[] = []
  const { core } = await sourceInventory(root)
  const src = path.join(root, 'src')
  const out = path.join(work, 'body')
  await fs.mkdir(work, { recursive: true })
  // A file tsc names, relative to root or else to work.
  const where = (file: string) => {
    const full = path.resolve(work, file)
    return path.relative(full.startsWith(`${root}/`) ? root : work, full).split(path.sep).join('/')
  }
  const report = (check: string, diagnostics: readonly Diagnostic[]) => {
    for (const diagnostic of diagnostics) problems.push({ check, text: diagnostic.file === null ? diagnostic.text : `${where(diagnostic.file)}(${diagnostic.line},${diagnostic.column}): ${diagnostic.code}: ${diagnostic.message}` })
  }

  // Declarations of the bodies alone, with the production options (allowJs and checkJs).
  const emit = path.join(work, 'tsconfig.body.json')
  const emitOptions = { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: out, rootDir: src, typeRoots: [path.join(root, 'node_modules', '@types')] }
  await fs.writeFile(emit, JSON.stringify({ extends: path.join(root, 'tsconfig.json'), compilerOptions: emitOptions, files: core.map((file) => path.join(root, file)), include: [] }, null, 2))
  const emitted = await tsc(emit, work)
  report('body', emitted.diagnostics)
  if (emitted.code !== 0) return { problems, checks: [] }
  const declarations = (await listFiles(out)).map((file) => path.join(out, file))
  const expected = core.map((file) => path.join(out, path.relative(src, path.join(root, file)).replace(/\.mjs$/, '.d.mts')))
  assert.deepEqual(declarations, expected.sort(), 'tsc did not emit one declaration for each core module')
  const emittedSet = new Set(declarations)
  for (const declaration of declarations) {
    const dir = path.join(src, path.relative(out, path.dirname(declaration)))
    const text = await fs.readFile(declaration, 'utf8')
    await fs.writeFile(declaration, await retarget(text, dir, path.dirname(declaration), emittedSet, problems, where(declaration)))
  }

  // The comparison, one generated line per check.
  const lines = [
    '// Generated by test/types.test.ts: the bodies of the core modules against their sidecars.',
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false',
    'type IsAny<T> = 0 extends 1 & T ? true : false',
  ]
  const checkAt = new Map<number, string>()
  const add = (check: string, line: string) => {
    lines.push(line)
    checkAt.set(lines.length, check)
  }
  for (const [i, file] of core.entries()) {
    const body = `./${path.relative(work, expected[i]!).split(path.sep).join('/').replace(/\.d\.mts$/, '.mjs')}`
    const sidecar = path.relative(work, path.join(root, file)).split(path.sep).join('/')
    lines.push(`import * as body${i} from '${body}'`, `import * as sidecar${i} from '${sidecar}'`)
    const names = Object.keys((await import(pathToFileURL(path.join(root, file)).href)) as object)
    const union = names.length === 0 ? 'never' : names.map((name) => JSON.stringify(name)).join(' | ')
    add(`${file} exports: body`, `export const names${i}b: Equal<keyof typeof body${i}, ${union}> = true`)
    add(`${file} exports: sidecar`, `export const names${i}s: Equal<keyof typeof sidecar${i}, ${union}> = true`)
    for (const [j, name] of names.entries()) {
      const [b, s] = [`typeof body${i}.${name}`, `typeof sidecar${i}.${name}`]
      // Identity alone would accept any on both sides.
      add(`${file} ${name}: typed`, `export const typed${i}_${j}: [IsAny<${b}>, IsAny<${s}>] = [false, false]`)
      add(`${file} ${name}: body to sidecar`, `export const to${i}_${j} = (value: ${b}): ${s} => value`)
      add(`${file} ${name}: sidecar to body`, `export const from${i}_${j} = (value: ${s}): ${b} => value`)
      const members = SIDECAR_ONLY_MEMBERS[name]
      if (members === undefined) {
        add(`${file} ${name}: identical`, `export const same${i}_${j}: Equal<${b}, ${s}> = true`)
        continue
      }
      const omitted = members.map((member) => JSON.stringify(member)).join(' | ')
      add(`${file} ${name}: constructor`, `export const new${i}_${j}: Equal<ConstructorParameters<${b}>, ConstructorParameters<${s}>> = true`)
      add(`${file} ${name}: instance`, `export const instance${i}_${j}: Equal<Omit<InstanceType<${b}>, never>, Omit<InstanceType<${s}>, ${omitted}>> = true`)
      add(`${file} ${name}: statics`, `export const statics${i}_${j}: Equal<Omit<${b}, 'prototype'>, Omit<${s}, 'prototype'>> = true`)
      add(`${file} ${name}: sidecar only`, `export const only${i}_${j}: Equal<Extract<keyof InstanceType<${b}>, ${omitted}>, never> = true`)
    }
  }
  const program = path.join(work, 'contract.mts')
  await fs.writeFile(program, `${lines.join('\n')}\n`)
  // Without allowJs, nothing here is typed from JavaScript; without skipLibCheck, the declarations,
  // emitted and authored, are checked too.
  const options = { ...(await compilerOptions({ skipLibCheck: false })), typeRoots: [path.join(root, 'node_modules', '@types')] }
  const project = path.join(work, 'tsconfig.contract.json')
  await fs.writeFile(project, JSON.stringify({ compilerOptions: options, files: [program] }, null, 2))
  const compared = await tsc(project, work)
  for (const diagnostic of compared.diagnostics) {
    const check = diagnostic.file === 'contract.mts' ? checkAt.get(diagnostic.line!) : undefined
    report(check ?? 'contract', [diagnostic])
  }
  return { problems, checks: [...checkAt.values()] }
}

test('every core module declares in its sidecar exactly the exports and types its body implements', async (t) => {
  const { problems, checks } = await contractCheck(ROOT, path.join(temp, 'contract'))
  assert.deepEqual(problems, [])
  const { core } = await sourceInventory()
  t.diagnostic(`${checks.length} checks over ${core.length} core modules`)
  // Every module was compared, by export, ForumError without its declared topic.
  for (const file of core) assert.ok(checks.includes(`${file} exports: sidecar`), file)
  for (const check of ['src/cli.mjs main: identical', 'src/forum.mjs createForum: identical', 'src/backends/jsonl.mjs jsonlAdapter: identical', 'src/cursor.mjs decodeCursor: identical']) {
    assert.ok(checks.includes(check), check)
  }
  for (const file of ['src/records.mjs', 'src/forum.mjs', 'src/storage.mjs']) assert.ok(checks.includes(`${file} ForumError: sidecar only`), file)
  assert.ok(checks.length > 80, `${checks.length} checks`)
})

// A scratch copy of the checkout, with this checkout's node_modules linked in, whose files edit()
// changes. Each control has its own: Node caches the modules a check imports by their path.
async function scratch(name: string, edits: Record<string, (text: string) => string>): Promise<string> {
  const root = path.join(temp, 'scratch', name)
  await copyCheckout(root)
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'))
  for (const [file, edit] of Object.entries(edits)) {
    const text = await fs.readFile(path.join(root, file), 'utf8')
    const edited = edit(text)
    assert.notEqual(edited, text, `the edit of ${file} changed nothing`)
    await fs.writeFile(path.join(root, file), edited)
  }
  return root
}

// Replaces text that occurs exactly once.
const replaceOnce = (from: string, to: string) => (text: string) => {
  assert.equal(text.split(from).length, 2, `${JSON.stringify(from)} does not occur exactly once`)
  return text.replace(from, to)
}

test('a type error in a core body is found next to its sidecar, by npm run typecheck and the contract check', async () => {
  const error = "\n/** @type {number} */\nconst notANumber = 'text'\nvoid notANumber\n"
  const root = await scratch('body-error', { 'src/cursor.mjs': (text) => `${text}${error}` })
  const line = (await fs.readFile(path.join(root, 'src/cursor.mjs'), 'utf8')).split('\n').indexOf('const notANumber = \'text\'') + 1
  const typecheck = await tsc(path.join(root, 'tsconfig.json'), root)
  assert.deepEqual(typecheck.diagnostics.map(({ file, line, code }) => [file, line, code]), [['src/cursor.mjs', line, 'TS2322']], texts(typecheck.diagnostics).join('\n'))
  const { problems } = await contractCheck(root, path.join(temp, 'work', 'body-error'))
  assert.deepEqual(problems.map(({ check }) => check), ['body'])
  assert.match(problems[0]!.text, new RegExp(`^src/cursor\\.mjs\\(${line},\\d+\\): TS2322: `))
})

test('an invalid declaration in a sidecar is found by the core-only check without skipLibCheck', async () => {
  const root = await scratch('invalid-sidecar', { 'src/cursor.d.mts': replaceOnce('  offset: number\n', '  offset: MissingOffset\n') })
  const sidecars = (await sourceInventory(root)).sidecars
  const project = path.join(root, 'tsconfig.core.json')
  await fs.writeFile(project, JSON.stringify({ compilerOptions: await compilerOptions({ skipLibCheck: false }), files: sidecars }, null, 2))
  const result = await tsc(project, root)
  assert.deepEqual(result.diagnostics.map(({ file, code }) => [file, code]), [['src/cursor.d.mts', 'TS2304']], texts(result.diagnostics).join('\n'))
  assert.match(result.diagnostics[0]!.message, /^Cannot find name 'MissingOffset'\./)
  // The contract check reads the sidecars without skipLibCheck too.
  const { problems } = await contractCheck(root, path.join(temp, 'work', 'invalid-sidecar'))
  assert.ok(problems.some(({ check, text }) => check === 'contract' && text.startsWith('src/cursor.d.mts(') && text.includes('TS2304')), JSON.stringify(problems))
})

// Each edit leaves the bodies and the declarations valid on their own; only the contract between
// them breaks, in the named checks.
for (const [name, edits, failed] of [
  [
    'a body that requires a parameter its sidecar leaves optional',
    { 'src/storage.mjs': replaceOnce(' * @param {WriteCallOptions} [options]\n * @returns {Promise<Message>}', ' * @param {WriteCallOptions} options\n * @returns {Promise<Message>}') },
    ['src/storage.mjs postMessage: body to sidecar', 'src/storage.mjs postMessage: identical'],
  ],
  [
    'a sidecar that widens a result its body never returns',
    { 'src/storage.d.mts': replaceOnce('options?: ListOptions): Promise<Page<Topic>>', 'options?: ListOptions): Promise<Page<Topic> | null>') },
    ['src/storage.mjs listTopics: sidecar to body', 'src/storage.mjs listTopics: identical'],
  ],
  [
    'a body that narrows a parameter its sidecar accepts',
    { 'src/cli.mjs': replaceOnce(' * @param {readonly string[]} argv\n * @param {Environment} [env]', ' * @param {string[]} argv\n * @param {Environment} [env]') },
    ['src/cli.mjs main: body to sidecar', 'src/cli.mjs main: identical'],
  ],
  [
    'an export typed any on both sides, which identity alone accepts',
    {
      'src/backends/jsonl.mjs': replaceOnce('/** @type {ForumAdapter} */\nexport const jsonlAdapter', '/** @type {any} */\nexport const jsonlAdapter'),
      'src/backends/jsonl.d.mts': replaceOnce('export declare const jsonlAdapter: ForumAdapter', 'export declare const jsonlAdapter: any'),
    },
    ['src/backends/jsonl.mjs jsonlAdapter: typed'],
  ],
  [
    'an export its sidecar does not declare',
    { 'src/cursor.mjs': (text: string) => `${text}\n/** @returns {number} */\nexport function cursorVersion() {\n  return 1\n}\n` },
    ['src/cursor.mjs exports: sidecar', ...['typed', 'body to sidecar', 'sidecar to body', 'identical'].map((check) => `src/cursor.mjs cursorVersion: ${check}`)],
  ],
  [
    'a sidecar declaring an export the module lacks',
    { 'src/records.d.mts': (text: string) => `${text}\nexport declare const MAX_TOPICS: number\n` },
    ['src/records.mjs exports: sidecar'],
  ],
  [
    'a declared-only member the body now implements',
    { 'src/records.mjs': replaceOnce('    /** @type {ForumErrorCode} */', '    /** @type {Topic | undefined} */\n    this.topic = undefined\n    /** @type {ForumErrorCode} */') },
    ['src/records.mjs', 'src/forum.mjs', 'src/storage.mjs'].flatMap((file) => ['body to sidecar', 'sidecar to body', 'instance', 'sidecar only'].map((check) => `${file} ForumError: ${check}`)),
  ],
] as const) {
  test(`the contract check finds ${name}`, async () => {
    const slug = name.replaceAll(/\W+/g, '-')
    const root = await scratch(slug, edits)
    // The edit is valid on both sides: the production check of the bodies passes.
    assert.deepEqual(await tsc(path.join(root, 'tsconfig.json'), root), { code: 0, diagnostics: [] })
    const { problems } = await contractCheck(root, path.join(temp, 'work', slug))
    assert.deepEqual([...new Set(problems.map(({ check }) => check))].sort(), [...failed].sort(), problems.map(({ check, text }) => `${check}: ${text}`).join('\n'))
  })
}

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
  const runs: CompilerRun[] = [
    { code: 0, stdout: 'Segmentation fault\n' },
    { code: 2, stdout: `${DIAGNOSTIC}\nFound 1 error.\n` },
    { code: 1, stdout: '  an indented line before any diagnostic\n' },
    { code: 0, stdout: '', stderr: 'warning: something\n' },
    { code: 2, stdout: `${DIAGNOSTIC}\n`, stderr: 'warning: something\n' },
  ]
  for (const run of runs) {
    assert.throws(
      () => compilerResult(run),
      (err: Error) => err.message.includes(`--- stdout\n${run.stdout}--- stderr\n${run.stderr ?? ''}`),
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
  // One diagnostic line reads as exactly one diagnostic.
  const diagnostic = (file: string, code: string, message: string) => compilerResult({ code: 2, stdout: `${file}(1,1): error ${code}: ${message}\n` }).diagnostics[0]!
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
    diagnostic('node_modules/pi-forum/src/cursor.d.mts', 'TS2304', "Cannot find name 'Missing'."),
    diagnostic(`${vendor}@earendil-works/pi-ai/dist/providers/openai.models.d.ts`, 'TS2304', "Cannot find name 'Model'."),
    diagnostic(`${vendor}@earendil-works/pi-ai/dist/index.d.ts`, 'TS1543', json),
    diagnostic(`${vendor}@google/genai/dist/node/node.d.ts`, 'TS2304', "Cannot find name 'Forum'."),
    diagnostic(`${vendor}@google/genai/dist/node/node.d.ts`, 'TS2307', "Cannot find module 'pi-forum/src/forum.mjs' or its corresponding type declarations."),
    diagnostic(`${vendor}@earendil-works/pi-coding-agent/dist/index.d.ts`, 'TS2307', "Cannot find module '@modelcontextprotocol/sdk/client/index.js'."),
  ]) {
    assert.equal(isVendorDiagnostic(rejected), false, rejected.text)
  }
  assert.equal(isVendorDiagnostic({ file: null, code: 'TS1543', message: json }), false)
})

test('the checks left the working tree unchanged', async () => {
  assert.deepEqual(await snapshot(ROOT, { files: await checkoutFiles() }), tree)
})
