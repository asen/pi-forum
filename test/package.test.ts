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
import type { Message, Page, Topic } from '../src/types.js'
import { ROOT, SOURCE_DIRS, checkoutFiles, copyCheckout, generatedInventory, listFiles, snapshot } from './checkout.ts'
import type { Inventory, Snapshot } from './checkout.ts'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
let temp: string
let tarball: string
let pkg: string
let inventory: Inventory
let tree: Snapshot

// The packaged package.json as these tests read it: any field may be missing or hold anything, and
// the assertions check what each must be.
type Manifest = Record<string, unknown> & { scripts?: Record<string, string>; devDependencies: Record<string, string> }

// An entry renderer as the renderer test calls it, with only the entry fields it reads and no theme.
type DrawEntry = (entry: Partial<CustomEntry>, options: EntryRenderOptions, theme: object) => Component | undefined

// What the CLI prints for topic create.
interface CreatedTopic {
  topic: Topic
  message: Message
}

// Packs the working tree with npm and extracts the tarball, as an installer would see it. Scripts are
// skipped, so prepack's build neither needs the dev dependencies nor rewrites the working tree: the
// tarball holds the tracked generated files, as Git and local installs use them, and npm run
// check-generated keeps those equal to what the build would write (the build and prepack themselves
// are tested in scratch copies by build.test.ts).
before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-package-test-'))
  inventory = await generatedInventory()
  tree = await snapshot(ROOT, { files: await checkoutFiles() })
  const { stdout } = await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: ROOT, env: npmEnv('pack') })
  const [{ filename }] = JSON.parse(stdout) as [{ filename: string }]
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

// The only hand-written JavaScript: two bootstraps that start TypeScript or generated code, given by
// their lines other than blank lines and comments. bin/pi-forum is the package's executable, as it
// always was; scripts/build.mjs keeps `node scripts/build.mjs` (npm run build, check-generated and
// prepack) running scripts/build.ts.
const BOOTSTRAPS = new Map<string, readonly string[]>([
  ['bin/pi-forum', ['#!/usr/bin/env node', "import { main } from '../src/cli.js'", 'process.exitCode = await main(process.argv.slice(2))']],
  ['scripts/build.mjs', ["import './build.ts'"]],
])
// TypeScript that npm run typecheck leaves to a test: the type fixture compiles only against the
// packed package, in types.test.ts.
const CHECKED_BY_TESTS = ['test/types/consumer.ts']
// A file holds code when it has a JavaScript or TypeScript extension (declarations included), an
// executable mode or a shebang.
const CODE = /\.[cm]?[jt]sx?$/
const TYPESCRIPT = /\.[cm]?tsx?$/

interface CheckoutFile {
  file: string
  mode: number
  text: string
}

const holdsCode = ({ file, mode, text }: CheckoutFile): boolean => CODE.test(file) || (mode & 0o111) !== 0 || text.startsWith('#!')

// The comment directives that switch type checking off: @ts-nocheck for a file, @ts-ignore for the
// next line. @ts-expect-error stays allowed, as it fails the check when the line has no error. Only
// real comments count, wherever they are (after code, or inside a template literal's
// interpolation), so the source is parsed: a directive in a string, a template literal's text or a
// regular expression is data, and a mention later in a comment is prose. As TypeScript reads them, a
// directive starts a line comment, after at most one more slash, or any line of a block comment,
// after its decoration of slashes and stars; as a prefix, so @ts-ignored counts too.
const LINE_DIRECTIVE = /^\/?\s*@ts-(ignore|nocheck)/
const BLOCK_DIRECTIVE = /^\s*[/*]*\s*@ts-(ignore|nocheck)/
// The line terminators of JavaScript, by which Babel numbers lines.
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/
const DECLARATION = /\.d\.[cm]?ts$/

// What a parse error carries besides its message: Babel's SyntaxError has the position it stopped at.
type ParseFailure = Error & { loc?: { line: number; column: number } }

// The forbidden directives in one TypeScript file, each with its line, or why it could not be read: a
// file the parser rejects fails the check rather than passing unread.
function suppressions(file: string, text: string): string[] {
  // .mts and .cts files never hold JSX, and TypeScript reads them so; .tsx files do.
  const plugins: ParserPlugin[] = [['typescript', { dts: DECLARATION.test(file), disallowAmbiguousJSXLike: /\.[cm]ts$/.test(file) }]]
  if (file.endsWith('.tsx')) plugins.push('jsx')
  let parsed
  try {
    parsed = parse(text, { sourceType: 'module', plugins, attachComment: false, errorRecovery: false })
  } catch (err) {
    const { message, loc } = err as ParseFailure
    return [`${file}${loc ? `:${loc.line}:${loc.column + 1}` : ''} cannot be parsed: ${message}`]
  }
  if (parsed.errors?.length || !Array.isArray(parsed.comments)) return [`${file} cannot be parsed: the parser returned errors or no comments`]
  return parsed.comments.flatMap(({ type, value, loc }) => {
    if (!loc) return [`${file} cannot be parsed: a comment has no location`]
    const [lines, directive] = type === 'CommentLine' ? [[value], LINE_DIRECTIVE] : [value.split(LINE_TERMINATOR), BLOCK_DIRECTIVE]
    return lines.flatMap((line, i) => {
      const match = directive.exec(line)
      return match ? [`${file}:${loc.start.line + i} contains forbidden @ts-${match[1]} comment directive`] : []
    })
  })
}

// The files holding code that is neither generated, a bootstrap exactly as above, nor TypeScript
// that a type check reads (checked: the files tsc reads for npm run typecheck), and the TypeScript
// comments that switch the check off, each with why.
function uncheckedCode(files: readonly CheckoutFile[], generated: readonly string[], checked: ReadonlySet<string>): string[] {
  const problems: string[] = []
  for (const { file, text } of files.filter(holdsCode)) {
    const bootstrap = BOOTSTRAPS.get(file)
    if (generated.includes(file)) continue
    if (bootstrap) {
      const lines = text.split('\n').filter((line) => line.trim() !== '' && !line.trim().startsWith('//'))
      if (!isDeepStrictEqual(lines, bootstrap)) problems.push(`${file} does more than start its TypeScript or generated code`)
    } else if (!TYPESCRIPT.test(file)) {
      problems.push(`${file} is code but not TypeScript`)
    } else if (!checked.has(file) && !CHECKED_BY_TESTS.includes(file)) {
      problems.push(`${file} is TypeScript that no type check reads`)
    }
    if (TYPESCRIPT.test(file)) problems.push(...suppressions(file, text))
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
// build tooling, tests, their helpers and fixtures alike. Needs the dev dependencies (npm ci).
test('all authored code is type-checked TypeScript; the only JavaScript is generated or one of the two bootstraps', async () => {
  const checked = new Set([...(await compilerFiles('tsconfig.json')), ...(await compilerFiles('tsconfig.tooling.json'))])
  // The listing is real: it holds the production sources, the build, tests, helpers and fixtures.
  for (const file of [...inventory.sources, 'scripts/build.ts', 'test/package.test.ts', 'test/checkout.ts', 'test/fixtures/npm-logger.mts', 'test/test-globals.d.ts']) {
    assert.ok(checked.has(file), `tsc does not read ${file}`)
  }
  const files = await Promise.all(
    (await checkoutFiles()).map(async (file): Promise<CheckoutFile> => {
      const full = path.join(ROOT, file)
      return { file, mode: (await fs.stat(full)).mode, text: await fs.readFile(full, 'utf8') }
    }),
  )
  assert.deepEqual(uncheckedCode(files, inventory.generated, checked), [])
  // Among them, the tests' deliberate type errors, each marked with @ts-expect-error, are accepted.
  assert.ok(files.some((entry) => TYPESCRIPT.test(entry.file) && /^\s*\/\/ @ts-expect-error -- \S/m.test(entry.text)), 'no @ts-expect-error was checked')
  const javaScript = files.filter((entry) => holdsCode(entry) && !TYPESCRIPT.test(entry.file) && !inventory.generated.includes(entry.file))
  assert.deepEqual(javaScript.map((entry) => entry.file), [...BOOTSTRAPS.keys()].sort())
})

test('the authored-code check rejects unchecked TypeScript, other code and a bootstrap that does more', () => {
  const generated = ['src/forum.d.ts', 'src/forum.js']
  const checked = new Set(['src/forum.ts', 'test/a.test.ts', 'test/globals.d.ts', 'test/fixtures/tool.mts'])
  const file = (name: string, text = '', mode = 0o644): CheckoutFile => ({ file: name, mode, text })
  // BOOTSTRAPS has both names used here.
  const bootstrap = (name: string, extra = ''): CheckoutFile => file(name, `// Starts the code.\n\n${BOOTSTRAPS.get(name)!.join('\n')}\n${extra}`, 0o755)
  const allowed = [
    bootstrap('bin/pi-forum'),
    bootstrap('scripts/build.mjs'),
    ...generated.map((name) => file(name, 'export {}\n')),
    ...[...checked].filter((name) => name !== 'test/fixtures/tool.mts').map((name) => file(name, 'export {}\n')),
    file('test/fixtures/tool.mts', '#!/usr/bin/env node\nexport {}\n', 0o755),
    file('test/types/consumer.ts', 'export {}\n'),
    file('README.md', '# pi-forum\n'),
    file('package.json', '{}\n'),
  ]
  assert.deepEqual(uncheckedCode(allowed, generated, checked), [])
  for (const [entry, problem] of [
    [file('test/helper.js', 'export {}\n'), 'test/helper.js is code but not TypeScript'],
    [file('scripts/tool.mjs'), 'scripts/tool.mjs is code but not TypeScript'],
    [file('test/fixtures/probe.cjs'), 'test/fixtures/probe.cjs is code but not TypeScript'],
    [file('test/fixtures/view.jsx'), 'test/fixtures/view.jsx is code but not TypeScript'],
    [file('src/extra.js'), 'src/extra.js is code but not TypeScript'],
    [file('test/fixtures/run', 'node --test\n', 0o755), 'test/fixtures/run is code but not TypeScript'],
    [file('test/fixtures/hook', '#!/usr/bin/env node\nprocess.exit(1)\n'), 'test/fixtures/hook is code but not TypeScript'],
    [file('test/unchecked.ts'), 'test/unchecked.ts is TypeScript that no type check reads'],
    [file('scripts/legacy.cts'), 'scripts/legacy.cts is TypeScript that no type check reads'],
    [file('test/fixtures/stale.d.ts'), 'test/fixtures/stale.d.ts is TypeScript that no type check reads'],
    [bootstrap('bin/pi-forum', "console.log('more')\n"), 'bin/pi-forum does more than start its TypeScript or generated code'],
    [bootstrap('scripts/build.mjs', "import './other.ts'\n"), 'scripts/build.mjs does more than start its TypeScript or generated code'],
    [file('scripts/build.mjs', '// Runs nothing.\n'), 'scripts/build.mjs does more than start its TypeScript or generated code'],
  ] as const) {
    const files = [...allowed.filter((other) => other.file !== entry.file), entry]
    assert.deepEqual(uncheckedCode(files, generated, checked), [problem], entry.file)
  }
})

test('the authored-code check rejects @ts-nocheck and @ts-ignore comments, and keeps @ts-expect-error and directive-like data', () => {
  const checked = new Set(['src/forum.ts', 'test/a.test.ts', 'test/globals.d.ts', 'test/fixtures/tool.mts'])
  const check = (file: string, text: string) => uncheckedCode([{ file, mode: 0o644, text }], [], checked)
  const forbidden = (file: string, line: number, name: 'ignore' | 'nocheck') => `${file}:${line} contains forbidden @ts-${name} comment directive`
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
    ['src/forum.ts', 'export {}\n// @ts-ignore\n', [forbidden('src/forum.ts', 2, 'ignore')]],
    ['test/fixtures/tool.mts', '#!/usr/bin/env node\r\n// @ts-nocheck\r\n', [forbidden('test/fixtures/tool.mts', 2, 'nocheck')]],
    ['test/globals.d.ts', 'declare var x: string\n// @ts-ignore\ndeclare var y: number\n', [forbidden('test/globals.d.ts', 2, 'ignore')]],
    ['test/types/consumer.ts', "// @ts-ignore\nimport x from 'pi-forum/nope.js'\n", [forbidden('test/types/consumer.ts', 1, 'ignore')]],
  ] as const) {
    assert.deepEqual(check(file, text), problems, text)
  }
  // A file the parser rejects fails with where it stopped, even with a directive after that point; so
  // does angle-bracket assertion syntax in an .mts file, which TypeScript does not allow there.
  for (const [file, text, problem] of [
    ['test/a.test.ts', 'const = 1\n// @ts-ignore\n', /^test\/a\.test\.ts:1:7 cannot be parsed: \S/],
    ['test/a.test.ts', 'f()\r\nconst t = `${\r\n', /^test\/a\.test\.ts:3:1 cannot be parsed: \S/],
    ['test/fixtures/tool.mts', '#!/usr/bin/env node\nconst n = <number>value\n', /^test\/fixtures\/tool\.mts:2:\d+ cannot be parsed: \S/],
  ] as const) {
    const problems = check(file, text)
    assert.equal(problems.length, 1, problems.join('\n'))
    assert.match(problems[0]!, problem)
  }
})

test('the tarball contains exactly the runtime files and their declarations, as tracked', async () => {
  const expected = ['bin/pi-forum', 'package.json', ...DOCS, ...inventory.generated].sort()
  const files = await listFiles(pkg)
  assert.deepEqual(files, expected)
  // Generated JavaScript and declarations ship; TypeScript sources, build tooling, tests, compiler
  // configurations and the lockfile do not.
  for (const file of files) {
    assert.doesNotMatch(file, /(^|\/)(\.idea|\.git|node_modules|test|scripts)(\/|$)|\.tgz$|(?<!\.d)\.[cm]?ts$|\.map$|^(tsconfig(\.[\w-]+)?|package-lock)\.json$/)
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
    // The one group takes part in every match.
    const specifiers = [...text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*'([^']+)'/g)].map((match) => match[1]!)
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
  const manifest = JSON.parse(await fs.readFile(path.join(pkg, 'package.json'), 'utf8')) as Manifest
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
  assert.equal(manifest.scripts?.prepack, 'npm run build')
  assert.ok(Object.hasOwn(manifest.devDependencies, 'typescript'))
})

// The text formatter and entry renderer have no host imports, so the packaged copies load here. They
// are byte for byte the checkout's generated modules, so they have those modules' types.
test('the packaged text output and session entry renderer load from the tarball', async () => {
  const load = (file: string) => import(pathToFileURL(path.join(pkg, 'extension', file)).href)
  const { ENTRY_TYPE, createEntryRenderer, entryData }: typeof import('../extension/entry-renderer.js') = await load('entry-renderer.js')
  const { LIST_PAGE_SIZE, formatTopicList }: typeof import('../extension/output.js') = await load('output.js')
  assert.equal(ENTRY_TYPE, 'pi-forum.output')
  assert.deepEqual(entryData('text'), { text: 'text' })
  assert.equal(LIST_PAGE_SIZE, 20)
  const text = formatTopicList({
    target: { forumDir: '/forum', generated: false, status: 'on' },
    page: { items: [{ id: 't1', title: 'Plan', created_by: 'ralph', created_at: '2026-01-01T00:00:00.000Z' }], next_cursor: 'c1' },
  })
  assert.equal(text.split('\n').at(-1), 'You are caught up.')
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
  const { createPreferenceStore, PREFERENCES_FILE }: typeof import('../extension/preferences.js') = await import(
    pathToFileURL(path.join(pkg, 'extension', 'preferences.js')).href
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

test('the packaged executable runs by direct path, through PATH and through a symlink', async () => {
  const forumDir = path.join(temp, 'forum')
  const links = path.join(temp, 'links')
  await fs.mkdir(links)
  await fs.symlink(path.join(pkg, 'bin', 'pi-forum'), path.join(links, 'pi-forum'))
  const options = (pathDirs: readonly string[]) => ({
    cwd: temp,
    env: { PATH: [...pathDirs, NODE_DIR].join(path.delimiter), PI_FORUM_DIR: forumDir, PI_SESSION_ID: 'pkg-session' },
  })

  const help = await exec(path.join(pkg, 'bin', 'pi-forum'), ['--help'], { cwd: temp, env: { PATH: NODE_DIR } })
  assert.match(help.stdout, /^Usage:\n {2}pi-forum topic create/)

  const created = await exec(path.join(pkg, 'bin', 'pi-forum'), ['topic', 'create', 'Packaged', '--body', 'hi'], options([]))
  const { topic, message } = JSON.parse(created.stdout) as CreatedTopic
  assert.equal(topic.created_by, 'pkg-session')
  assert.equal(message.body, 'hi')

  const viaPath = await exec('pi-forum', ['message', 'post', topic.id, '--body', 'via PATH'], options([path.join(pkg, 'bin')]))
  assert.equal((JSON.parse(viaPath.stdout) as { message: Message }).message.body, 'via PATH')

  const viaLink = await exec('pi-forum', ['message', 'list', '--topic', topic.id], options([links]))
  assert.deepEqual((JSON.parse(viaLink.stdout) as Page<Message>).items.map((m) => m.body), ['hi', 'via PATH'])
  for (const result of [help, created, viaPath, viaLink]) assert.equal(result.stderr, '')
})

// Runs an installed pi-forum executable once: creates a topic in a new forum and lists it back.
async function runInstalled(bin: string, label: string): Promise<void> {
  const forumDir = path.join(temp, `forum-${label}`)
  const env = { PATH: NODE_DIR, PI_FORUM_DIR: forumDir, PI_SESSION_ID: label }
  const created = await exec(bin, ['topic', 'create', label, '--body', 'installed'], { cwd: temp, env })
  assert.equal(created.stderr, '')
  const listed = await exec(bin, ['topic', 'list'], { cwd: temp, env })
  assert.deepEqual((JSON.parse(listed.stdout) as Page<Topic>).items.map((t) => [t.title, t.created_by]), [[label, label]])
}

// As Pi installs an npm source: npm install <spec> --prefix <root> --legacy-peer-deps into a root
// holding only a private package.json. Peers are not installed, nothing is built, and the installed
// files are exactly those of the tarball. Real extension loading from such an install is covered
// against Pi itself in pi-integration.test.ts.
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
  const { formatTopicList }: typeof import('../extension/output.js') = await import(pathToFileURL(path.join(installed, 'extension', 'output.js')).href)
  assert.equal(typeof formatTopicList, 'function')
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
// npm installs nothing and runs no build: the tracked generated JavaScript is what loads, every file
// is left as committed, and node_modules holds at most npm's record of installing nothing. Pi's own
// git install and loading are covered in pi-integration.test.ts.
test('a Git checkout installs offline with npm install --omit=dev --legacy-peer-deps, unchanged and without a build', async () => {
  const checkout = path.join(temp, 'git-checkout')
  const files = await copyCheckout(checkout)
  for (const file of [...inventory.generated, 'package-lock.json']) assert.ok(files.includes(file), `${file} is not committed`)
  const committed = await snapshot(checkout, { files })
  const contents = (state: Snapshot) => Object.fromEntries(Object.entries(state).map(([file, entry]) => [file, entry && { sha256: entry.sha256, mode: entry.mode }]))
  await exec('npm', ['install', '--omit=dev', '--legacy-peer-deps'], { cwd: checkout, env: npmEnv('git-install', { offline: true }) })
  assert.deepEqual(await listFiles(checkout, { skip: ['node_modules'] }), files)
  await assertNothingInstalled(checkout)
  assert.deepEqual(contents(await snapshot(checkout, { files })), contents(committed))
  await runInstalled(path.join(checkout, 'bin', 'pi-forum'), 'git-installed')
  const { createPreferenceStore }: typeof import('../extension/preferences.js') = await import(pathToFileURL(path.join(checkout, 'extension', 'preferences.js')).href)
  assert.equal(typeof createPreferenceStore, 'function')
})

test('packing and installing left the working tree unchanged', async () => {
  assert.deepEqual(await snapshot(ROOT, { files: await checkoutFiles() }), tree)
})
