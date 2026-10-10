import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual, promisify } from 'node:util'
import { parse } from '@babel/parser'
import type { ParserPlugin } from '@babel/parser'
import type { CustomEntry, EntryRenderOptions } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import type { Message, Page, SearchHit, Topic } from '../src/types.d.mts'
import { ROOT, TYPE_ONLY, checkoutFiles, copyCheckout, listFiles, sidecarOf, snapshot, sourceInventory } from './checkout.ts'
import type { Inventory, Snapshot } from './checkout.ts'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
let temp: string
let tarball: string
let pkg: string
let inventory: Inventory
let tree: Snapshot
let packed: PackResult

// The packaged package.json as these tests read it: any field may be missing or hold anything, and
// the assertions check what each must be.
type Manifest = Record<string, unknown> & { scripts?: Record<string, string>; devDependencies: Record<string, string> }

// An entry renderer as the renderer test calls it, with only the entry fields it reads and no theme.
type DrawEntry = (entry: Partial<CustomEntry>, options: EntryRenderOptions, theme: object) => Component | undefined

// A failed execFile call, as far as these tests read it: its exit status and output.
interface ExecFailure {
  code: number
  stdout: string
  stderr: string
}

// What the CLI prints for topic create.
interface CreatedTopic {
  topic: Topic
  message: Message
}

// One package as npm pack --json lists it, as far as these tests read it.
interface PackedPackage {
  filename: string
  files: { path: string; mode: number }[]
}

// The scratch pack: what npm printed besides the tarball's name.
interface PackResult {
  stdout: string
  stderr: string
}

// The npm that Node ships next to itself, or else the first on PATH.
async function findNpm(): Promise<string> {
  for (const dir of [NODE_DIR, ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean)]) {
    const npm = path.join(dir, 'npm')
    if (await fs.access(npm, fs.constants.X_OK).then(() => true, () => false)) return npm
  }
  throw new Error('npm is not on PATH')
}

// Packs a scratch copy of the checkout with a plain npm pack, as a publish would, and extracts the
// tarball, as an installer would see it. The copy holds the files a commit would (see
// copyCheckout) and no node_modules, npm runs offline, and PATH holds only Node and the system: the
// package ships its authored sources as they are, so packing needs no dev dependency, compiler, peer
// or lifecycle script, and nothing is skipped to get there.
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-package-test-'))
  inventory = await sourceInventory()
  tree = await snapshot(ROOT, { files: await checkoutFiles() })
  const checkout = path.join(temp, 'pack-checkout')
  await copyCheckout(checkout)
  const env = { ...npmEnv('pack', { offline: true }), PATH: SYSTEM_PATH }
  const { stdout, stderr } = await exec(await findNpm(), ['pack', '--json', '--pack-destination', temp], { cwd: checkout, env })
  packed = { stdout, stderr }
  const [{ filename }] = JSON.parse(stdout) as [PackedPackage]
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
function npmEnv(cache: string, { offline = false }: { offline?: boolean } = {}): NodeJS.ProcessEnv {
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
// PATH for runs that may use nothing but Node and the system: no compiler or other dev tool.
const SYSTEM_PATH = [NODE_DIR, '/usr/bin', '/bin'].join(path.delimiter)
const DOCS = ['README.md', 'docs/architecture.md', 'LICENSE']
const HOST_PEERS = ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']
// The two entry points: the executable, which runs the CLI, and the extension Pi loads.
const BIN = 'bin/pi-forum'
const EXTENSION_ENTRY = 'extension/forum.ts'
// Node with its TypeScript type stripping off, for runs that must need no TypeScript at all.
const PLAIN_NODE = '--no-experimental-strip-types'

test('every production module is authored source: core JavaScript with its sidecar declaration, or extension TypeScript', async () => {
  assert.deepEqual(inventory.others, [], 'files under src/ or extension/ that are neither core modules, their declarations nor extension TypeScript')
  for (const file of ['src/cli.mjs', 'src/forum.mjs', 'src/backends/jsonl.mjs']) assert.ok(inventory.core.includes(file), file)
  assert.ok(inventory.extension.includes(EXTENSION_ENTRY), EXTENSION_ENTRY)
  // Each core module has its sidecar, and each sidecar its module, but for the type-only shapes.
  assert.deepEqual(inventory.core.map(sidecarOf), inventory.sidecars.filter((file) => !TYPE_ONLY.includes(file)))
  for (const file of TYPE_ONLY) {
    assert.ok(inventory.sidecars.includes(file), `${file} is missing`)
    assert.ok(!inventory.core.includes(file.replace(/\.d\.mts$/, '.mjs')), `${file} declares types only, yet has a module`)
  }
  // All of them are authored: a commit holds every one.
  const committed = await checkoutFiles()
  for (const file of inventory.shipped) assert.ok(committed.includes(file), `${file} is ignored or untracked by Git`)
})

// The only other JavaScript: the package's executable, a bootstrap that starts the CLI, given by its
// lines other than blank lines and comments.
const BOOTSTRAPS = new Map<string, readonly string[]>([
  [BIN, ['#!/usr/bin/env node', "import { main } from '../src/cli.mjs'", 'process.exitCode = await main(process.argv.slice(2))']],
])
// TypeScript that npm run typecheck leaves to a test: the type fixture compiles only against the
// packed package, in types.test.ts.
const CHECKED_BY_TESTS = ['test/types/consumer.ts']
// A file holds code when it has a JavaScript or TypeScript extension (declarations included), an
// executable mode or a shebang.
const CODE = /\.[cm]?[jt]sx?$/
const TYPESCRIPT = /\.[cm]?tsx?$/
// The authored JavaScript core, which tsc checks through its JSDoc (checkJs).
const CORE_JAVASCRIPT = /^src\/(?:[\w-]+\/)*[\w-]+\.mjs$/
// Shipped production code, where no type error may be suppressed, expected or not.
const PRODUCTION = /^(?:src|extension)\//

interface CheckoutFile {
  file: string
  mode: number
  text: string
}

const holdsCode = ({ file, mode, text }: CheckoutFile): boolean => CODE.test(file) || (mode & 0o111) !== 0 || text.startsWith('#!')

// The comment directives that switch type checking off: @ts-nocheck for a file, @ts-ignore for the
// next line, in TypeScript and checked JavaScript alike. Outside production, @ts-expect-error stays
// allowed, as it fails the check when the line has no error; shipped code may not use it either. Only
// real comments count, wherever they are (after code, or inside a template literal's
// interpolation), so the source is parsed: a directive in a string, a template literal's text or a
// regular expression is data, and a mention later in a comment is prose. As TypeScript reads them, a
// directive starts a line comment, after at most one more slash, or any line of a block comment,
// after its decoration of slashes and stars; as a prefix, so @ts-ignored counts too.
const LINE_DIRECTIVE = /^\/?\s*@ts-(ignore|nocheck|expect-error)/
const BLOCK_DIRECTIVE = /^\s*[/*]*\s*@ts-(ignore|nocheck|expect-error)/
// The line terminators of JavaScript, by which Babel numbers lines.
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/
const DECLARATION = /\.d\.[cm]?ts$/

// What a parse error carries besides its message: Babel's SyntaxError has the position it stopped at.
type ParseFailure = Error & { loc?: { line: number; column: number } }

// A node of the syntax tree Babel returns, as far as the import scan reads it.
interface SyntaxNode {
  type: string
  [key: string]: unknown
}

type Parsed = ReturnType<typeof parse>

// Parses one TypeScript or JavaScript file as a module, as TypeScript reads it, or returns why it
// cannot be: a file the parser rejects fails a check rather than passing unread.
function parseModule(file: string, text: string): Parsed | string {
  const plugins: ParserPlugin[] = []
  if (TYPESCRIPT.test(file)) {
    // .mts and .cts files never hold JSX, and TypeScript reads them so; .tsx files do.
    plugins.push(['typescript', { dts: DECLARATION.test(file), disallowAmbiguousJSXLike: /\.[cm]ts$/.test(file) }])
    if (file.endsWith('.tsx')) plugins.push('jsx')
  }
  let parsed
  try {
    parsed = parse(text, { sourceType: 'module', plugins, attachComment: false, errorRecovery: false })
  } catch (err) {
    const { message, loc } = err as ParseFailure
    return `${file}${loc ? `:${loc.line}:${loc.column + 1}` : ''} cannot be parsed: ${message}`
  }
  if (parsed.errors?.length || !Array.isArray(parsed.comments)) return `${file} cannot be parsed: the parser returned errors or no comments`
  return parsed
}

// The forbidden directives in one TypeScript or checked JavaScript file, each with its line, or why
// it could not be read.
function suppressions(file: string, text: string): string[] {
  const parsed = parseModule(file, text)
  if (typeof parsed === 'string') return [parsed]
  return parsed.comments!.flatMap(({ type, value, loc }) => {
    if (!loc) return [`${file} cannot be parsed: a comment has no location`]
    const [lines, directive] = type === 'CommentLine' ? [[value], LINE_DIRECTIVE] : [value.split(LINE_TERMINATOR), BLOCK_DIRECTIVE]
    return lines.flatMap((line, i) => {
      const match = directive.exec(line)
      if (!match || (match[1] === 'expect-error' && !PRODUCTION.test(file))) return []
      return [`${file}:${loc.start.line + i} contains forbidden @ts-${match[1]} comment directive`]
    })
  })
}

// The files holding code that is neither the bootstrap exactly as above, TypeScript that a type check
// reads, nor core JavaScript that it reads (checked: the files tsc reads for npm run typecheck), and
// the comments that switch the check off, each with why.
function uncheckedCode(files: readonly CheckoutFile[], checked: ReadonlySet<string>): string[] {
  const problems: string[] = []
  for (const { file, text } of files.filter(holdsCode)) {
    const bootstrap = BOOTSTRAPS.get(file)
    if (bootstrap) {
      const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
      if (!isDeepStrictEqual(lines, bootstrap)) problems.push(`${file} does more than start the CLI`)
    } else if (CORE_JAVASCRIPT.test(file)) {
      if (!checked.has(file)) problems.push(`${file} is JavaScript that no type check reads`)
    } else if (!TYPESCRIPT.test(file)) {
      problems.push(`${file} is code but neither TypeScript nor core JavaScript`)
    } else if (!checked.has(file) && !CHECKED_BY_TESTS.includes(file)) {
      problems.push(`${file} is TypeScript that no type check reads`)
    }
    if (TYPESCRIPT.test(file) || CORE_JAVASCRIPT.test(file)) problems.push(...suppressions(file, text))
  }
  return problems
}

// The checkout files tsc reads for one of its projects, from --listFilesOnly (which checks nothing);
// files outside the checkout or under node_modules are left out. A tsc that fails to run or writes
// to stderr fails the test.
async function compilerFiles(project: string): Promise<string[]> {
  const manifest = require.resolve('typescript/package.json')
  const bin = path.join(path.dirname(manifest), (require(manifest) as { bin: { tsc: string } }).bin.tsc)
  const { stdout, stderr } = await exec(process.execPath, [bin, '-p', project, '--listFilesOnly'], { cwd: ROOT })
  assert.equal(stderr, '')
  const root = await fs.realpath(ROOT)
  const files = stdout.split('\n').filter(Boolean)
  for (const file of files) assert.ok(path.isAbsolute(file), `tsc listed ${JSON.stringify(file)}`)
  return files
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => !file.startsWith('../') && !file.startsWith('node_modules/'))
}

// Covers every file a commit would hold (tracked, or untracked and not ignored): production code,
// tests, their helpers and fixtures alike. Needs the dev dependencies (npm ci).
test('all authored code is type-checked TypeScript or core JavaScript; the only other JavaScript is the executable bootstrap', async () => {
  const checked = new Set([...(await compilerFiles('tsconfig.json')), ...(await compilerFiles('tsconfig.tooling.json'))])
  // The listing is real: it holds the production sources and declarations, tests, helpers and fixtures.
  for (const file of [...inventory.shipped, 'test/package.test.ts', 'test/checkout.ts', 'test/fixtures/npm-logger.mts', 'test/test-globals.d.ts']) {
    assert.ok(checked.has(file), `tsc does not read ${file}`)
  }
  const files = await Promise.all(
    (await checkoutFiles()).map(async (file): Promise<CheckoutFile> => {
      const full = path.join(ROOT, file)
      return { file, mode: (await fs.stat(full)).mode, text: await fs.readFile(full, 'utf8') }
    }),
  )
  assert.deepEqual(uncheckedCode(files, checked), [])
  // Among them, the tests' deliberate type errors, each marked with @ts-expect-error, are accepted.
  assert.ok(files.some((entry) => TYPESCRIPT.test(entry.file) && /^\s*\/\/ @ts-expect-error -- \S/m.test(entry.text)), 'no @ts-expect-error was checked')
  const javaScript = files.filter((entry) => holdsCode(entry) && !TYPESCRIPT.test(entry.file))
  assert.deepEqual(javaScript.map((entry) => entry.file), [BIN, ...inventory.core].sort())
})

test('the authored-code check rejects unchecked TypeScript and JavaScript, other code and a bootstrap that does more', () => {
  const checked = new Set(['src/forum.mjs', 'src/backends/jsonl.mjs', 'src/forum.d.mts', 'extension/forum.ts', 'test/a.test.ts', 'test/globals.d.ts', 'test/fixtures/tool.mts'])
  const file = (name: string, text = '', mode = 0o644): CheckoutFile => ({ file: name, mode, text })
  const bootstrap = (extra = ''): CheckoutFile => file(BIN, `// Starts the CLI.\n\n${BOOTSTRAPS.get(BIN)!.join('\n')}\n${extra}`, 0o755)
  const allowed = [
    bootstrap(),
    ...[...checked].filter((name) => name !== 'test/fixtures/tool.mts').map((name) => file(name, 'export {}\n')),
    file('test/fixtures/tool.mts', '#!/usr/bin/env node\nexport {}\n', 0o755),
    file('test/types/consumer.ts', 'export {}\n'),
    file('README.md', '# pi-forum\n'),
    file('package.json', '{}\n'),
  ]
  assert.deepEqual(uncheckedCode(allowed, checked), [])
  for (const [entry, problem] of [
    [file('test/helper.js', 'export {}\n'), 'test/helper.js is code but neither TypeScript nor core JavaScript'],
    [file('test/helper.mjs', 'export {}\n'), 'test/helper.mjs is code but neither TypeScript nor core JavaScript'],
    [file('scripts/tool.mjs'), 'scripts/tool.mjs is code but neither TypeScript nor core JavaScript'],
    [file('test/fixtures/probe.cjs'), 'test/fixtures/probe.cjs is code but neither TypeScript nor core JavaScript'],
    [file('test/fixtures/view.jsx'), 'test/fixtures/view.jsx is code but neither TypeScript nor core JavaScript'],
    // Generated files of the earlier build, or JavaScript beside the extension: never core JavaScript.
    [file('src/forum.js'), 'src/forum.js is code but neither TypeScript nor core JavaScript'],
    [file('src/backends/jsonl.cjs'), 'src/backends/jsonl.cjs is code but neither TypeScript nor core JavaScript'],
    [file('extension/forum.mjs'), 'extension/forum.mjs is code but neither TypeScript nor core JavaScript'],
    [file('test/fixtures/run', 'node --test\n', 0o755), 'test/fixtures/run is code but neither TypeScript nor core JavaScript'],
    [file('test/fixtures/hook', '#!/usr/bin/env node\nprocess.exit(1)\n'), 'test/fixtures/hook is code but neither TypeScript nor core JavaScript'],
    [file('src/extra.mjs'), 'src/extra.mjs is JavaScript that no type check reads'],
    [file('src/backends/other.mjs'), 'src/backends/other.mjs is JavaScript that no type check reads'],
    [file('test/unchecked.ts'), 'test/unchecked.ts is TypeScript that no type check reads'],
    [file('extension/stray.ts'), 'extension/stray.ts is TypeScript that no type check reads'],
    [file('src/stale.d.mts'), 'src/stale.d.mts is TypeScript that no type check reads'],
    [file('scripts/legacy.cts'), 'scripts/legacy.cts is TypeScript that no type check reads'],
    [file('test/fixtures/stale.d.ts'), 'test/fixtures/stale.d.ts is TypeScript that no type check reads'],
    [bootstrap("console.log('more')\n"), 'bin/pi-forum does more than start the CLI'],
    [file(BIN, "#!/usr/bin/env node\nimport { main } from '../src/cli.js'\nprocess.exitCode = await main(process.argv.slice(2))\n", 0o755), 'bin/pi-forum does more than start the CLI'],
    [file(BIN, '// Runs nothing.\n', 0o755), 'bin/pi-forum does more than start the CLI'],
  ] as const) {
    const files = [...allowed.filter((other) => other.file !== entry.file), entry]
    assert.deepEqual(uncheckedCode(files, checked), [problem], entry.file)
  }
})

test('the authored-code check rejects @ts-nocheck and @ts-ignore comments, and keeps @ts-expect-error outside production and directive-like data', () => {
  const checked = new Set(['src/forum.mjs', 'src/forum.d.mts', 'extension/forum.ts', 'test/a.test.ts', 'test/globals.d.ts', 'test/fixtures/tool.mts'])
  const check = (file: string, text: string) => uncheckedCode([{ file, mode: 0o644, text }], checked)
  const forbidden = (file: string, line: number, name: 'ignore' | 'nocheck' | 'expect-error') => `${file}:${line} contains forbidden @ts-${name} comment directive`
  for (const [file, text] of [
    ['test/a.test.ts', '// @ts-expect-error -- deliberately invalid input, rejected at run time\nf(1)\n'],
    ['test/a.test.ts', '  /* @ts-expect-error -- not a Topic */ const topic: Topic = {}\n/**\n * @ts-expect-error is fine\n */\n'],
    // Prose that names a directive later in a comment.
    ['test/a.test.ts', '// Never use @ts-ignore or @ts-nocheck here.\n/* See the @ts-ignore rule.\n   Prefer @ts-expect-error. */\n'],
    // Strings, including one continued over an escaped line break.
    ['test/a.test.ts', "const directive = '// @ts-ignore'\nconst pragma = \"/* @ts-nocheck */\"\nconst s = 'a\\\n// @ts-ignore'\nconst url = 'https://example.com/@ts-ignore'\n"],
    ['test/a.test.ts', "const unmarked = lines.map((line) => (line.trim().startsWith('// @ts-expect-error') ? '//' : line))\n"],
    // Template literal text: multi-line (compiler test data), with escaped backticks, and nested.
    ['test/a.test.ts', "const fixture = `\n// @ts-ignore\nconst n: number = 'x'\n`\n"],
    ['test/a.test.ts', 'const t = `\\`\n// @ts-ignore\\``\n'],
    ['test/a.test.ts', 'const t = `a ${`\n/* @ts-nocheck */\n${`// @ts-ignore`}`} b`\n'],
    // Regular expression literals.
    ['test/a.test.ts', 'const r = /\\/\\/ @ts-ignore/\nconst c = /[/*]\\s*@ts-nocheck/\nconst d = /@ts-ignore/u\n'],
    // The same assertion syntax that .mts and .cts files may not use is fine in a .ts file.
    ['test/a.test.ts', 'const n = <number>value\n'],
    ['test/globals.d.ts', 'declare var x: string // see the @ts-ignore rule\n'],
    // Core JavaScript, read as JavaScript: JSDoc types, and directive-like strings and prose.
    ['src/forum.mjs', "/** @import { Forum } from './types.d.mts' */\n/** @type {string} */\nconst s = '// @ts-ignore'\n// See the @ts-nocheck rule.\nexport {}\n"],
    ['src/forum.mjs', 'const r = /\\/\\/ @ts-expect-error/\nconst t = `\n/* @ts-nocheck */\n`\n'],
  ] as const) {
    assert.deepEqual(check(file, text), [], text)
  }
  for (const [file, text, problems] of [
    ['test/a.test.ts', '// @ts-nocheck\nexport {}\n', [forbidden('test/a.test.ts', 1, 'nocheck')]],
    ['test/a.test.ts', '//@ts-nocheck\n', [forbidden('test/a.test.ts', 1, 'nocheck')]],
    ['test/a.test.ts', 'export {}\n// @ts-ignore\nconst n: number = f()\n', [forbidden('test/a.test.ts', 2, 'ignore')]],
    ['test/a.test.ts', '  /// @ts-ignore: no reason is enough\n', [forbidden('test/a.test.ts', 1, 'ignore')]],
    // Conservatively, as a prefix.
    ['test/a.test.ts', '// @ts-ignored\n', [forbidden('test/a.test.ts', 1, 'ignore')]],
    // After code, including after a string continued over an escaped line break and after a regular
    // expression literal.
    ['test/a.test.ts', "f('a') // @ts-ignore\n", [forbidden('test/a.test.ts', 1, 'ignore')]],
    ['test/a.test.ts', "const s = 'a\\\nb' // @ts-ignore\n", [forbidden('test/a.test.ts', 2, 'ignore')]],
    ['test/a.test.ts', 'const r = /\\/\\// // @ts-ignore\n', [forbidden('test/a.test.ts', 1, 'ignore')]],
    // Block comments, on any line of their body and with any decoration.
    ['test/a.test.ts', '/* @ts-ignore */ f()\n', [forbidden('test/a.test.ts', 1, 'ignore')]],
    ['test/a.test.ts', '/**\n * text\n *\n * @ts-ignore\n */\n', [forbidden('test/a.test.ts', 4, 'ignore')]],
    ['test/a.test.ts', '/* note\n   @ts-ignore */\nf()\n', [forbidden('test/a.test.ts', 2, 'ignore')]],
    ['test/a.test.ts', '/*** @ts-nocheck ***/\n/*\n ///* @ts-ignore\n */\n', [forbidden('test/a.test.ts', 1, 'nocheck'), forbidden('test/a.test.ts', 3, 'ignore')]],
    // Adjacent comments, each its own.
    ['test/a.test.ts', '/* a *//* @ts-ignore */// @ts-nocheck\n// fine\n// @ts-ignore\n', [forbidden('test/a.test.ts', 1, 'ignore'), forbidden('test/a.test.ts', 1, 'nocheck'), forbidden('test/a.test.ts', 3, 'ignore')]],
    // Comments inside template literal interpolations, nested or spread over lines.
    ['test/a.test.ts', 'const t = `a ${f() /* @ts-ignore */} b`\n', [forbidden('test/a.test.ts', 1, 'ignore')]],
    ['test/a.test.ts', 'const t = `a\n${f( // @ts-nocheck\n)}\n`\n', [forbidden('test/a.test.ts', 2, 'nocheck')]],
    ['test/a.test.ts', 'const t = `${`${x /* @ts-ignore */}`}`\n', [forbidden('test/a.test.ts', 1, 'ignore')]],
    // Lines as JavaScript counts them: CRLF, CR, U+2028 and U+2029, in code and in block comments.
    ['test/a.test.ts', 'export {}\r\n\r\n// @ts-ignore\r\n', [forbidden('test/a.test.ts', 3, 'ignore')]],
    ['test/a.test.ts', 'f()\r// @ts-nocheck\r', [forbidden('test/a.test.ts', 2, 'nocheck')]],
    ['test/a.test.ts', 'f()\u2028// @ts-ignore\u2029f()\n/* a\u2029 * b\u2028 @ts-nocheck */\n', [forbidden('test/a.test.ts', 2, 'ignore'), forbidden('test/a.test.ts', 6, 'nocheck')]],
    // Production sources, a fixture after its shebang, a declaration and the consumer fixture alike.
    ['extension/forum.ts', 'export {}\n// @ts-ignore\n', [forbidden('extension/forum.ts', 2, 'ignore')]],
    ['test/fixtures/tool.mts', '#!/usr/bin/env node\r\n// @ts-nocheck\r\n', [forbidden('test/fixtures/tool.mts', 2, 'nocheck')]],
    ['test/globals.d.ts', 'declare var x: string\n// @ts-ignore\ndeclare var y: number\n', [forbidden('test/globals.d.ts', 2, 'ignore')]],
    ['test/types/consumer.ts', "// @ts-ignore\nimport x from 'pi-forum/nope.js'\n", [forbidden('test/types/consumer.ts', 1, 'ignore')]],
    // Core JavaScript and its declarations: as TypeScript reads checked JavaScript, in line and block
    // comments, JSDoc included.
    ['src/forum.mjs', 'export {}\n// @ts-ignore\nf()\n', [forbidden('src/forum.mjs', 2, 'ignore')]],
    ['src/forum.mjs', '/** @ts-nocheck */\nexport {}\n', [forbidden('src/forum.mjs', 1, 'nocheck')]],
    ['src/forum.mjs', '/**\n * @param {string} a\n * @ts-ignore\n */\nfunction f(a) {}\n', [forbidden('src/forum.mjs', 3, 'ignore')]],
    ['src/forum.d.mts', 'export {}\n// @ts-ignore\nexport declare const x: number\n', [forbidden('src/forum.d.mts', 2, 'ignore')]],
    // Shipped code may not even expect an error; tests may.
    ['src/forum.mjs', "// @ts-expect-error -- not a number\nconst n = /** @type {number} */ ('x')\n", [forbidden('src/forum.mjs', 1, 'expect-error')]],
    ['extension/forum.ts', "const a = 1\n/* @ts-expect-error */ const n: number = 'x'\n", [forbidden('extension/forum.ts', 2, 'expect-error')]],
    ['src/forum.d.mts', '// @ts-expect-error\nexport declare const x: Missing\n', [forbidden('src/forum.d.mts', 1, 'expect-error')]],
  ] as const) {
    assert.deepEqual(check(file, text), problems, text)
  }
  // A file the parser rejects fails with where it stopped, even with a directive after that point; so
  // does angle-bracket assertion syntax in an .mts file, which TypeScript does not allow there.
  for (const [file, text, problem] of [
    ['test/a.test.ts', 'const = 1\n// @ts-ignore\n', /^test\/a\.test\.ts:1:7 cannot be parsed: \S/],
    ['test/a.test.ts', 'f()\r\nconst t = `${\r\n', /^test\/a\.test\.ts:3:1 cannot be parsed: \S/],
    ['test/fixtures/tool.mts', '#!/usr/bin/env node\nconst n = <number>value\n', /^test\/fixtures\/tool\.mts:2:\d+ cannot be parsed: \S/],
    // Core JavaScript is parsed as JavaScript, so TypeScript syntax in it does not pass unread.
    ['src/forum.mjs', 'export {}\nconst n: number = 1\n// @ts-ignore\n', /^src\/forum\.mjs:2:\d+ cannot be parsed: \S/],
  ] as const) {
    const problems = check(file, text)
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0]!, problem)
  }
})

test('a plain npm pack of a checkout without dependencies packs the authored sources, running nothing', async () => {
  // npm printed the package and nothing else: no lifecycle script ran.
  assert.equal(packed.stderr, '')
  const [entry, ...more] = JSON.parse(packed.stdout) as PackedPackage[]
  assert.equal(more.length, 0)
  assert.deepEqual(entry!.files.map((file) => file.path).sort(), await listFiles(pkg))
  // The working tree itself packs the same files.
  const { stdout } = await exec(await findNpm(), ['pack', '--dry-run', '--json'], { cwd: ROOT, env: npmEnv('pack-dry-run', { offline: true }) })
  assert.deepEqual((JSON.parse(stdout) as PackedPackage[])[0]!.files.map((file) => file.path).sort(), await listFiles(pkg))
})

test('the tarball contains exactly the authored runtime sources, their declarations and the docs, as committed', async () => {
  const expected = [BIN, 'package.json', ...DOCS, ...inventory.shipped].sort()
  const files = await listFiles(pkg)
  assert.deepEqual(files, expected)
  // The core JavaScript, its sidecar declarations and the extension TypeScript ship; generated
  // JavaScript or declarations, tests, tooling, compiler configurations and the lockfile do not.
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(\.idea|\.git|node_modules|test|scripts|dist)(\/|$)|\.tgz$|\.map$|\.tsbuildinfo$|\.(c?js|jsx|tsx|d\.c?ts)$|^(tsconfig(\.[\w-]+)?|package-lock)\.json$/)
    assert.match(file, /^(bin\/pi-forum|package\.json|README\.md|LICENSE|docs\/architecture\.md|src\/([\w-]+\/)*[\w-]+\.(mjs|d\.mts)|extension\/[\w-]+\.ts)$/)
  }
  for (const file of [...DOCS, BIN, ...inventory.shipped]) {
    assert.deepEqual(await fs.readFile(path.join(pkg, file)), await fs.readFile(path.join(ROOT, file)), file)
  }
  assert.match(await fs.readFile(path.join(pkg, 'LICENSE'), 'utf8'), /^MIT License\n\nCopyright \(c\) \d{4} \S/)
  const runtime = [EXTENSION_ENTRY, 'extension/runtime.ts', 'extension/preferences.ts', 'extension/output.ts', 'extension/entry-renderer.ts', 'extension/types.ts']
  const core = ['src/cli.mjs', 'src/forum.mjs', 'src/search-query.mjs', 'src/backends/jsonl.mjs']
  const declarations = ['src/forum.d.mts', 'src/search-query.d.mts', 'src/backends/jsonl.d.mts', 'src/types.d.mts']
  for (const file of [...runtime, ...core, ...declarations]) {
    assert.ok(files.includes(file), file)
  }
})

// One module specifier a file names: in code (an import, a re-export or an import type) or in a
// JSDoc comment (@import or import()). runtime is whether Node or Pi's loader loads it: an import that
// is not type-only, in code that is not a declaration.
interface ModuleImport {
  specifier: string
  runtime: boolean
}

// Every node of a Babel syntax tree.
function* syntaxNodes(value: unknown): Generator<SyntaxNode> {
  if (Array.isArray(value)) {
    for (const item of value) yield* syntaxNodes(item)
  } else if (value !== null && typeof value === 'object' && typeof (value as SyntaxNode).type === 'string') {
    yield value as SyntaxNode
    for (const [key, child] of Object.entries(value)) if (key !== 'loc' && key !== 'extra') yield* syntaxNodes(child)
  }
}

// Whether every specifier of an import or export declaration is type-only (none means a side effect).
const typeOnly = (node: SyntaxNode, kind: 'importKind' | 'exportKind') => {
  const specifiers = (node.specifiers ?? []) as SyntaxNode[]
  return node[kind] === 'type' || (specifiers.length > 0 && specifiers.every((specifier) => specifier[kind] === 'type'))
}
const JSDOC_IMPORT = /@import\b[^]*?\bfrom\s*'([^']+)'|\bimport\(\s*'([^']+)'\s*\)/g

// The modules one file names, or why it cannot be read (a dynamic import of a computed name included).
function moduleImports(file: string, text: string): ModuleImport[] | string {
  const parsed = parseModule(file, text)
  if (typeof parsed === 'string') return parsed
  const declaration = DECLARATION.test(file)
  const imports: ModuleImport[] = []
  for (const node of syntaxNodes(parsed.program)) {
    const source = node.source as SyntaxNode | null | undefined
    if (node.type === 'ImportDeclaration') imports.push({ specifier: source!.value as string, runtime: !declaration && !typeOnly(node, 'importKind') })
    else if ((node.type === 'ExportNamedDeclaration' && source) || node.type === 'ExportAllDeclaration') {
      imports.push({ specifier: source!.value as string, runtime: !declaration && !typeOnly(node, 'exportKind') })
    } else if (node.type === 'TSImportType') {
      imports.push({ specifier: (node.argument as SyntaxNode).value as string, runtime: false })
    } else if (node.type === 'TSExternalModuleReference') {
      return `${file} uses import = require()`
    } else if (node.type === 'CallExpression' && (node.callee as SyntaxNode).type === 'Import') {
      const [argument] = node.arguments as SyntaxNode[]
      if (argument?.type !== 'StringLiteral') return `${file} imports a computed module name`
      imports.push({ specifier: argument.value as string, runtime: !declaration })
    }
  }
  for (const comment of parsed.comments!) {
    for (const match of comment.value.matchAll(JSDOC_IMPORT)) imports.push({ specifier: (match[1] ?? match[2])!, runtime: false })
  }
  return imports
}

// What is wrong with the modules one shipped file names: bare names must be Node built-ins, or for
// the extension the host peers, which Pi supplies; the core never imports a peer, as the CLI runs
// without them. Relative names must land on shipped files, by their exact name: the core imports core
// modules, the declarations and the extension import declarations only for their types, and a core
// module an importer types has its sidecar. Only the extension imports TypeScript.
function importProblems(file: string, imports: readonly ModuleImport[], shipped: ReadonlySet<string>): string[] {
  const problems: string[] = []
  for (const { specifier, runtime } of imports) {
    if (!specifier.startsWith('.')) {
      if (!specifier.startsWith('node:') && !(file.startsWith('extension/') && HOST_PEERS.includes(specifier))) problems.push(`${file} imports ${specifier}`)
      continue
    }
    const target = path.posix.join(path.posix.dirname(file), specifier)
    if (!shipped.has(target)) problems.push(`${file} imports ${specifier}, which is not shipped`)
    else if (target.endsWith('.d.mts') && runtime) problems.push(`${file} imports the declaration ${specifier} at run time`)
    else if (target.endsWith('.mjs') && !shipped.has(sidecarOf(target))) problems.push(`${file} imports ${specifier}, which has no sidecar`)
    else if (target.endsWith('.ts') && !DECLARATION.test(target) && !file.startsWith('extension/')) problems.push(`${file} imports the TypeScript ${specifier}`)
  }
  return problems
}

// The files a run loads from the entry, following runtime imports, and the bare modules it imports.
async function runtimeClosure(dir: string, entry: string): Promise<{ files: string[]; bare: string[] }> {
  const files = new Set<string>()
  const bare = new Set<string>()
  const pending = [entry]
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) continue
    files.add(file)
    // The executable is JavaScript without an extension.
    const imports = moduleImports(file === BIN ? `${file}.mjs` : file, await fs.readFile(path.join(dir, file), 'utf8'))
    if (typeof imports === 'string') throw new Error(imports)
    for (const { specifier } of imports.filter((entry) => entry.runtime)) {
      if (specifier.startsWith('.')) pending.push(path.posix.join(path.posix.dirname(file), specifier))
      else bare.add(specifier)
    }
  }
  return { files: [...files].sort(), bare: [...bare].sort() }
}

test('the packaged modules and declarations import only shipped files, by their exact names, Node built-ins and the host peers', async () => {
  const shipped = new Set(await listFiles(pkg))
  const problems: string[] = []
  let named = 0
  for (const file of inventory.shipped) {
    const text = await fs.readFile(path.join(pkg, file), 'utf8')
    assert.doesNotMatch(text, /sourceMappingURL/, file)
    const imports = moduleImports(file, text)
    if (typeof imports === 'string') problems.push(imports)
    else {
      named += imports.length
      problems.push(...importProblems(file, imports, shipped))
    }
  }
  assert.deepEqual(problems, [])
  assert.ok(named > inventory.shipped.length, `${named} imports`)
  assert.match(await fs.readFile(path.join(pkg, 'src/forum.d.mts'), 'utf8'), /^export declare function createForum\(options: CreateForumOptions\): Forum$/m)
  assert.match(await fs.readFile(path.join(pkg, EXTENSION_ENTRY), 'utf8'), /^export default function piForum\(pi: ForumExtensionAPI\): void \{$/m)
})

// What Node loads to run the CLI is plain JavaScript: the core modules and Node built-ins, never
// TypeScript, a declaration or a peer. What Pi loads for the extension is its TypeScript, the core
// and the host peers.
test('the executable loads only core JavaScript and Node built-ins; the extension adds its TypeScript and the host peers', async () => {
  const cli = await runtimeClosure(pkg, BIN)
  assert.deepEqual(cli.files.filter((file) => file !== BIN && !inventory.core.includes(file)), [])
  for (const file of ['src/cli.mjs', 'src/forum.mjs', 'src/records.mjs', 'src/cursor.mjs', 'src/backends/jsonl.mjs']) assert.ok(cli.files.includes(file), file)
  assert.deepEqual(cli.bare.filter((name) => !name.startsWith('node:')), [])
  const extension = await runtimeClosure(pkg, EXTENSION_ENTRY)
  assert.deepEqual(extension.files.filter((file) => !inventory.extension.includes(file) && !inventory.core.includes(file)), [])
  for (const file of [EXTENSION_ENTRY, 'extension/runtime.ts', 'src/forum.mjs']) assert.ok(extension.files.includes(file), file)
  assert.deepEqual(extension.bare.filter((name) => !name.startsWith('node:') && !HOST_PEERS.includes(name)), [])
})

test('the import check rejects imports that miss shipped files, load declarations or TypeScript, or name other packages', () => {
  const shipped = new Set(['src/forum.mjs', 'src/forum.d.mts', 'src/types.d.mts', 'src/backends/jsonl.mjs', 'src/backends/jsonl.d.mts', 'src/extra.mjs', 'extension/forum.ts', 'extension/types.ts'])
  const problems = (file: string, text: string) => {
    const imports = moduleImports(file, text)
    return typeof imports === 'string' ? [imports] : importProblems(file, imports, shipped)
  }
  for (const [file, text] of [
    ['src/forum.mjs', "import path from 'node:path'\nimport { jsonlAdapter } from './backends/jsonl.mjs'\n/** @import { Forum } from './types.d.mts' */\n/** @type {import('./types.d.mts').Topic} */\nexport {}\n"],
    ['src/backends/jsonl.d.mts', "import type { ForumAdapter } from '../types.d.mts'\nexport { createForum } from '../forum.mjs'\nexport declare const a: import('../types.d.mts').Topic\n"],
    ['extension/forum.ts', "import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'\nimport { createForum } from '../src/forum.mjs'\nimport type { Topic } from '../src/types.d.mts'\nimport { type Forum } from '../src/types.d.mts'\nimport type { View } from './types.ts'\nexport {}\n"],
  ] as const) {
    assert.deepEqual(problems(file, text), [], text)
  }
  for (const [file, text, expected] of [
    // The earlier generated names, and names relative to the wrong directory.
    ['src/forum.mjs', "import { jsonlAdapter } from './backends/jsonl.js'\n", ["src/forum.mjs imports ./backends/jsonl.js, which is not shipped"]],
    ['src/forum.mjs', "/** @import { Forum } from './types.js' */\n", ["src/forum.mjs imports ./types.js, which is not shipped"]],
    ['src/backends/jsonl.d.mts', "import type { Topic } from './types.d.mts'\n", ["src/backends/jsonl.d.mts imports ./types.d.mts, which is not shipped"]],
    ['extension/forum.ts', "import { createForum } from '../src/forum.ts'\n", ["extension/forum.ts imports ../src/forum.ts, which is not shipped"]],
    ['extension/forum.ts', "export type { View } from './types.js'\n", ["extension/forum.ts imports ./types.js, which is not shipped"]],
    // A declaration loaded at run time, as a value import or a re-export.
    ['extension/forum.ts', "import { Topic } from '../src/types.d.mts'\n", ["extension/forum.ts imports the declaration ../src/types.d.mts at run time"]],
    ['src/forum.mjs', "export * from './types.d.mts'\n", ["src/forum.mjs imports the declaration ./types.d.mts at run time"]],
    ['src/forum.mjs', "const t = await import('./types.d.mts')\n", ["src/forum.mjs imports the declaration ./types.d.mts at run time"]],
    // A core module without its sidecar, and TypeScript outside the extension.
    ['extension/forum.ts', "import { extra } from '../src/extra.mjs'\n", ["extension/forum.ts imports ../src/extra.mjs, which has no sidecar"]],
    ['src/forum.mjs', "import x from '../extension/forum.ts'\n", ["src/forum.mjs imports the TypeScript ../extension/forum.ts"]],
    ['src/forum.d.mts', "import type { View } from '../extension/types.ts'\n", ["src/forum.d.mts imports the TypeScript ../extension/types.ts"]],
    // Other packages: in the core, even the host peers; a bare built-in without node:.
    ['src/forum.mjs', "import { Text } from '@earendil-works/pi-tui'\n", ['src/forum.mjs imports @earendil-works/pi-tui']],
    ['src/forum.d.mts', "/** @import { Theme } from '@earendil-works/pi-coding-agent' */\nexport {}\n", ['src/forum.d.mts imports @earendil-works/pi-coding-agent']],
    ['extension/forum.ts', "import fs from 'fs'\nimport { parse } from '@babel/parser'\n", ['extension/forum.ts imports fs', 'extension/forum.ts imports @babel/parser']],
    ['src/forum.mjs', 'const m = await import(name)\n', ['src/forum.mjs imports a computed module name']],
  ] as const) {
    assert.deepEqual(problems(file, text), expected, text)
  }
})

test('the packaged manifest keeps its entry points, peers and install contract', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8')) as Manifest
  assert.equal(manifest.name, 'pi-forum')
  assert.equal(manifest.license, 'MIT')
  assert.deepEqual(manifest.bin, { 'pi-forum': BIN })
  assert.equal(manifest.type, 'module')
  assert.deepEqual(manifest.engines, { node: '>=22.19' })
  assert.deepEqual(manifest.pi, { extensions: [`./${EXTENSION_ENTRY}`] })
  assert.deepEqual(manifest.peerDependencies, { '@earendil-works/pi-coding-agent': '*', '@earendil-works/pi-tui': '*' })
  // No runtime dependencies, and modules are imported by path: no exports map or entry fields.
  for (const field of ['dependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'exports', 'main', 'types', 'typings']) {
    assert.equal(manifest[field], undefined, field)
  }
  // Nothing is ever built: not on install (Pi installs from Git omit dev dependencies, and local loads
  // do not install), not on pack or publish, and there is no build to run by hand.
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish', 'build', 'check-generated']) {
    assert.equal(manifest.scripts?.[hook], undefined, hook)
  }
  // The compiler is for contributors only: it checks the sources and emits nothing.
  assert.ok(Object.hasOwn(manifest.devDependencies, 'typescript'))
  assert.equal(manifest.scripts?.typecheck, 'tsc -p tsconfig.json && tsc -p tsconfig.tooling.json')
})

// The text formatter and entry renderer import nothing from the host at run time, so the packaged
// copies load here too: the extracted tarball is outside any node_modules, where Node strips their
// types. They are byte for byte the checkout's modules, so they have those modules' types. Pi's own
// loader, which also runs them from inside node_modules, is covered in pi-integration.test.ts.
test('the packaged text output and session entry renderer load from the tarball', async () => {
  const load = (file: string) => import(pathToFileURL(path.join(pkg, 'extension', file)).href)
  const { ENTRY_TYPE, createEntryRenderer, entryData }: typeof import('../extension/entry-renderer.ts') = await load('entry-renderer.ts')
  const { LIST_PAGE_SIZE, formatSearchResults, formatTopicList, textCommand }: typeof import('../extension/output.ts') = await load('output.ts')
  assert.equal(ENTRY_TYPE, 'pi-forum.output')
  assert.deepEqual(entryData('text'), { text: 'text' })
  assert.equal(LIST_PAGE_SIZE, 20)
  const text = formatTopicList({
    target: { forumDir: '/forum', generated: false, status: 'on' },
    page: { items: [{ id: 't1', title: 'Plan', created_by: 'ralph', created_at: '2026-01-01T00:00:00.000Z' }], next_cursor: 'c1' },
  })
  assert.equal(text.split('\n').at(-1), 'You are caught up.')
  const found = formatSearchResults({
    target: { forumDir: '/forum', generated: false, status: 'on' },
    query: '"release plan" OR (kickoff AND NOT x)',
    page: { items: [{ type: 'message', message: { id: 'm1', topic_id: 't1', author: 'ralph', body: 'Kickoff', created_at: '2026-01-01T00:00:00.000Z' } }], next_cursor: 'c1' },
  })
  assert.deepEqual(found.split('\n').slice(3), ['Query: "release plan" OR (kickoff AND NOT x)', '', '1. Message by ralph · 2026-01-01T00:00:00.000Z', '   Message m1 · topic t1', '   Kickoff', '', 'You are caught up.'])
  assert.equal(textCommand({ kind: 'search', query: '-x "a  b"', after: 'c1' }), '/forum search --after c1 -- -x "a  b"')
  class Text {
    constructor(shown: string, paddingX: number, paddingY: number) {
      Object.assign(this, { shown, paddingX, paddingY })
    }
  }
  // @ts-expect-error -- a Text stand-in that keeps its arguments, not a pi-tui component: the renderer only constructs it
  const render = createEntryRenderer({ Text }) as DrawEntry
  const drawn = render({ type: 'custom', customType: ENTRY_TYPE, data: entryData('a\x1b[31mb\nc') }, { expanded: false }, {})
  assert.deepEqual({ ...drawn }, { shown: 'a␛[31mb\nc', paddingX: 1, paddingY: 0 })
})

// The saved-defaults store imports only Node built-ins, so the packaged copy runs here too.
test('the packaged preference store saves and resets defaults from the tarball', async () => {
  const { createPreferenceStore, PREFERENCES_FILE }: typeof import('../extension/preferences.ts') = await import(
    pathToFileURL(path.join(pkg, 'extension', 'preferences.ts')).href
  )
  const agentDir = path.join(temp, 'prefs-agent')
  const cwd = path.join(temp, 'prefs-project')
  const store = createPreferenceStore({ getAgentDir: () => agentDir })
  const ctx = { cwd, isProjectTrusted: () => true }
  assert.equal(PREFERENCES_FILE, 'forum.json')
  assert.deepEqual(store.set('user', true, ctx), { ok: true, scope: 'user', path: path.join(agentDir, 'forum.json'), enabled: true, changed: true })
  assert.deepEqual(store.set('project', false, ctx), { ok: true, scope: 'project', path: path.join(cwd, '.pi', 'forum.json'), enabled: false, changed: true })
  assert.deepEqual([store.load(ctx).enabled, store.load(ctx).source], [false, 'project'])
  const reset = store.reset('project', ctx)
  assert.equal(reset.ok && reset.changed, true)
  assert.equal(await fs.readFile(path.join(cwd, '.pi', 'forum.json'), 'utf8'), '{}\n')
  assert.deepEqual([store.load(ctx).enabled, store.load(ctx).source], [true, 'user'])
  assert.equal(store.load({ cwd, isProjectTrusted: () => false }).project.ignored?.code, 'untrusted')
})

test('the packaged executable has mode 0755 and a node shebang', async () => {
  const bin = path.join(pkg, 'bin', 'pi-forum')
  assert.equal((await fs.stat(bin)).mode & 0o777, 0o755)
  assert.ok((await fs.readFile(bin, 'utf8')).startsWith('#!/usr/bin/env node\n'))
})

// Each run has Node's type stripping off: the executable and the core it loads are plain JavaScript.
test('the packaged executable runs by direct path, through PATH and through a symlink', async () => {
  const forumDir = path.join(temp, 'forum')
  const links = path.join(temp, 'links')
  await fs.mkdir(links)
  await fs.symlink(path.join(pkg, 'bin', 'pi-forum'), path.join(links, 'pi-forum'))
  const options = (pathDirs: readonly string[]) => ({
    cwd: temp,
    env: { PATH: [...pathDirs, NODE_DIR].join(path.delimiter), PI_FORUM_DIR: forumDir, PI_SESSION_ID: 'pkg-session', NODE_OPTIONS: PLAIN_NODE },
  })

  const help = await exec(path.join(pkg, 'bin', 'pi-forum'), ['--help'], { cwd: temp, env: { PATH: NODE_DIR, NODE_OPTIONS: PLAIN_NODE } })
  assert.match(help.stdout, /^Usage:\n {2}pi-forum topic create/)

  const created = await exec(path.join(pkg, 'bin', 'pi-forum'), ['topic', 'create', 'Packaged', '--body', 'hi'], options([]))
  const { topic, message } = JSON.parse(created.stdout) as CreatedTopic
  assert.equal(topic.created_by, 'pkg-session')
  assert.equal(message.body, 'hi')

  const viaPath = await exec('pi-forum', ['message', 'post', topic.id, '--body', 'via PATH'], options([path.join(pkg, 'bin')]))
  assert.equal((JSON.parse(viaPath.stdout) as { message: Message }).message.body, 'via PATH')

  const viaLink = await exec('pi-forum', ['message', 'list', '--topic', topic.id], options([links]))
  assert.deepEqual((JSON.parse(viaLink.stdout) as Page<Message>).items.map((m) => m.body), ['hi', 'via PATH'])
  // A search, its query one argument: a phrase and a group, matching a topic title and a message body.
  const searched = await exec('pi-forum', ['search', '"via PATH" OR (packaged AND NOT hi)', '--limit', '5'], options([links]))
  const hits = (JSON.parse(searched.stdout) as Page<SearchHit>).items
  assert.deepEqual(hits.map((hit) => (hit.type === 'topic' ? ['topic', hit.topic.title] : ['message', hit.message.body])), [['topic', 'Packaged'], ['message', 'via PATH']])
  assert.match(help.stdout, /\n {2}pi-forum search QUERY \[--after CURSOR\] \[--limit N\]\n/)
  for (const result of [help, created, viaPath, viaLink, searched]) assert.equal(result.stderr, '')
  // A malformed query fails with its offset and prints nothing.
  const failed = await exec(path.join(pkg, 'bin', 'pi-forum'), ['search', 'a AND'], options([])).then(
    () => assert.fail('a malformed query succeeded'),
    (err: ExecFailure) => err,
  )
  assert.deepEqual([failed.code, failed.stdout, failed.stderr], [1, '', 'pi-forum: error: search query expects a term, phrase or group at offset 5\n'])
})

// Runs an installed pi-forum executable once, with Node's type stripping off: creates a topic in a new
// forum and lists it back.
async function runInstalled(bin: string, label: string): Promise<void> {
  const forumDir = path.join(temp, `forum-${label}`)
  const env = { PATH: NODE_DIR, PI_FORUM_DIR: forumDir, PI_SESSION_ID: label, NODE_OPTIONS: PLAIN_NODE }
  const created = await exec(bin, ['topic', 'create', label, '--body', 'installed'], { cwd: temp, env })
  assert.equal(created.stderr, '')
  const listed = await exec(bin, ['topic', 'list'], { cwd: temp, env })
  assert.deepEqual((JSON.parse(listed.stdout) as Page<Topic>).items.map((t) => [t.title, t.created_by]), [[label, label]])
  const searched = await exec(bin, ['search', `"${label}" OR installed`], { cwd: temp, env })
  assert.deepEqual((JSON.parse(searched.stdout) as Page<SearchHit>).items.map((hit) => hit.type), ['topic', 'message'])
}

// Imports an installed copy's core with plain Node and writes and reads a forum through it.
async function useInstalledCore(dir: string, label: string): Promise<void> {
  const { createForum }: typeof import('../src/forum.mjs') = await import(pathToFileURL(path.join(dir, 'src', 'forum.mjs')).href)
  const { listTopics }: typeof import('../src/storage.mjs') = await import(pathToFileURL(path.join(dir, 'src', 'storage.mjs')).href)
  const forumDir = path.join(temp, `core-${label}`)
  const { topic } = await createForum({ forumDir }).createTopic({ title: label, author: label })
  assert.deepEqual((await listTopics(forumDir)).items, [topic])
  // Search through the installed API and its query compiler.
  const { compileSearchQuery, MAX_QUERY_BYTES }: typeof import('../src/search-query.mjs') = await import(pathToFileURL(path.join(dir, 'src', 'search-query.mjs')).href)
  assert.equal(MAX_QUERY_BYTES, 4096)
  assert.equal(compileSearchQuery(`"${label}" AND NOT x`)(label), true)
  assert.deepEqual((await createForum({ forumDir }).search(`"${label}"`)).items, [{ type: 'topic', topic }])
}

// As Pi installs an npm source: npm install <spec> --prefix <root> --legacy-peer-deps into a root
// holding only a private package.json. Peers are not installed, nothing is built, and the installed
// files are exactly those of the tarball. The executable and the core run from inside node_modules,
// where Node never strips types; Pi's own loader runs the extension's TypeScript from such an
// install, as covered against Pi itself in pi-integration.test.ts.
test('npm installs the tarball offline as Pi installs npm packages, with no peers, dev tools or build', async () => {
  const root = path.join(temp, 'npm-root')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'pi-extensions', private: true }, null, 2))
  const env = { ...npmEnv('npm-install', { offline: true }), PATH: SYSTEM_PATH }
  await exec(await findNpm(), ['install', tarball, '--prefix', root, '--legacy-peer-deps'], { cwd: root, env })
  const modules = path.join(root, 'node_modules')
  assert.deepEqual((await fs.readdir(modules)).sort(), ['.bin', '.package-lock.json', 'pi-forum'])
  assert.deepEqual(await fs.readdir(path.join(modules, '.bin')), ['pi-forum'])
  const installed = path.join(modules, 'pi-forum')
  assert.deepEqual(await listFiles(installed), await listFiles(pkg))
  for (const file of await listFiles(pkg)) {
    assert.deepEqual(await fs.readFile(path.join(installed, file)), await fs.readFile(path.join(pkg, file)), file)
  }
  await runInstalled(path.join(modules, '.bin', 'pi-forum'), 'npm-installed')
  await useInstalledCore(installed, 'npm-installed')
})

// What npm install --omit=dev leaves in a checkout whose dependencies it all omits: no node_modules
// with npm 11. npm 10 (10.9, bundled with Node 22) creates the directory of every package in its tree
// before it removes the omitted ones, which leaves their empty scope directories, and saves its hidden
// lockfile, node_modules/.package-lock.json, recording that no package is installed. Any other file,
// link or package fails.
async function assertNothingInstalled(dir: string): Promise<void> {
  const modules = path.join(dir, 'node_modules')
  const stat = await fs.lstat(modules).catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)))
  if (stat === null) return
  assert.ok(stat.isDirectory(), 'node_modules is not a directory')
  // Entries come from lstat, so a link is never a directory.
  const entries = await fs.readdir(modules, { recursive: true, withFileTypes: true })
  const others = entries.filter((entry) => !entry.isDirectory()).map((entry) => path.relative(modules, path.join(entry.parentPath, entry.name)))
  assert.deepEqual(others, ['.package-lock.json'])
  assert.ok((await fs.lstat(path.join(modules, '.package-lock.json'))).isFile(), 'node_modules/.package-lock.json is not a regular file')
  // npm's lockfile, as far as this reads it.
  const lock = JSON.parse(await fs.readFile(path.join(modules, '.package-lock.json'), 'utf8')) as { name: string; packages: unknown }
  assert.deepEqual([lock.name, lock.packages], ['pi-forum', {}])
}

// As Pi installs a Git source: after cloning, it runs npm install --omit=dev --legacy-peer-deps in
// the checkout. A snapshot of this checkout stands in for the clone. With no runtime dependencies,
// npm installs nothing and runs no build: the committed sources are what loads, every file is left as
// committed, and node_modules holds at most npm's record of installing nothing. Pi's own git install
// and loading are covered in pi-integration.test.ts.
test('a Git checkout installs offline with npm install --omit=dev --legacy-peer-deps, unchanged and without a build', async () => {
  const checkout = path.join(temp, 'git-checkout')
  const files = await copyCheckout(checkout)
  for (const file of [...inventory.shipped, BIN, 'package-lock.json']) assert.ok(files.includes(file), `${file} is not committed`)
  const committed = await snapshot(checkout, { files })
  const contents = (state: Snapshot) => Object.fromEntries(Object.entries(state).map(([file, entry]) => [file, entry && { sha256: entry.sha256, mode: entry.mode }]))
  const env = { ...npmEnv('git-install', { offline: true }), PATH: SYSTEM_PATH }
  await exec(await findNpm(), ['install', '--omit=dev', '--legacy-peer-deps'], { cwd: checkout, env })
  assert.deepEqual(await listFiles(checkout, { skip: ['node_modules'] }), files)
  await assertNothingInstalled(checkout)
  assert.deepEqual(contents(await snapshot(checkout, { files })), contents(committed))
  await runInstalled(path.join(checkout, 'bin', 'pi-forum'), 'git-installed')
  await useInstalledCore(checkout, 'git-installed')
})

test('packing and installing left the working tree unchanged', async () => {
  assert.deepEqual(await snapshot(ROOT, { files: await checkoutFiles() }), tree)
})
