// Emits the tracked JavaScript and declarations of the production TypeScript.
//
//   node scripts/build.mjs          compile, then update the generated files that differ
//   node scripts/build.mjs --check  compile, then report generated files that are missing or differ
//
// Every X.ts under src/ and extension/ owns exactly X.js and X.d.ts next to it. tsc emits into a
// temporary staging directory, so a failed compile changes nothing; only then are the owned files
// compared byte for byte and, outside --check, rewritten where they differ. JavaScript without a
// TypeScript source is still authored by hand and is never read or written. A declaration without
// a source is reported, as it is left over from a removed source, but never deleted.
//
// All output, tsc's diagnostics included, goes to stderr so npm pack --json, which runs this
// through prepack, keeps a parseable stdout.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE_DIRS = ['src', 'extension']
const OUTPUTS = ['.js', '.d.ts']

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  console.error('Usage: node scripts/build.mjs [--check]')
  process.exit(2)
}
const check = args[0] === '--check'
const name = check ? 'check-generated' : 'build'

// POSIX paths relative to base of the files under base/dir, sorted; none if dir does not exist.
async function walk(base, dir) {
  let entries
  try {
    entries = await fs.readdir(path.join(base, dir), { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const files = []
  for (const entry of entries) {
    const file = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(base, file)))
    else files.push(file)
  }
  return files.sort()
}

const walkAll = async (base) => (await Promise.all(SOURCE_DIRS.map((dir) => walk(base, dir)))).flat().sort()

async function readOrNull(file) {
  try {
    return await fs.readFile(file)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

function tsc(outDir) {
  const require = createRequire(import.meta.url)
  const manifest = require.resolve('typescript/package.json')
  const bin = path.join(path.dirname(manifest), require(manifest).bin.tsc)
  const project = path.join(ROOT, 'tsconfig.json')
  const result = spawnSync(process.execPath, [bin, '-p', project, '--noEmit', 'false', '--outDir', outDir], {
    cwd: ROOT,
    stdio: ['ignore', 2, 2],
  })
  if (result.error) throw result.error
  return result.status === 0
}

async function main() {
  const files = await walkAll(ROOT)
  const sources = files.filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
  const owned = sources.flatMap((file) => OUTPUTS.map((ext) => file.slice(0, -'.ts'.length) + ext)).sort()
  const problems = files
    .filter((file) => file.endsWith('.d.ts') && !sources.includes(file.slice(0, -'.d.ts'.length) + '.ts'))
    .map((file) => `${file} has no TypeScript source; remove it and its JavaScript if the source was removed`)

  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-forum-build-'))
  try {
    if (!tsc(stage)) {
      console.error(`${name}: tsc failed; no generated file was changed`)
      return 1
    }
    const emitted = await walkAll(stage)
    if (emitted.join('\n') !== owned.join('\n')) {
      console.error(`${name}: tsc emitted ${JSON.stringify(emitted)}, expected ${JSON.stringify(owned)}`)
      return 1
    }

    for (const file of owned) {
      const built = await fs.readFile(path.join(stage, file))
      const current = await readOrNull(path.join(ROOT, file))
      if (current !== null && built.equals(current)) continue
      if (check) {
        problems.push(`${file} ${current === null ? 'is missing' : 'differs from the build'}`)
      } else {
        await fs.writeFile(path.join(ROOT, file), built)
        console.error(`${name}: wrote ${file}`)
      }
    }
    for (const problem of problems) console.error(`${name}: ${problem}`)
    if (problems.length > 0) {
      if (check) console.error(`${name}: run npm run build and commit the generated files`)
      return 1
    }
    console.error(`${name}: ${owned.length} generated file(s) from ${sources.length} source(s) ${check ? 'are current' : 'are up to date'}`)
    return 0
  } finally {
    await fs.rm(stage, { recursive: true, force: true })
  }
}

process.exitCode = await main()
