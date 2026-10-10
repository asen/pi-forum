// Scratch copies of this checkout, for tests that pack, install or type-check it without touching the
// working tree, and the inventory of its production sources.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// The content hash, mode and modification time of a file, or null for a file that does not exist.
export type FileState = { sha256: string; mode: number; mtimeMs: number } | null
export type Snapshot = Record<string, FileState>

// The production sources, all authored and shipped as they are: nothing is generated from them.
export interface Inventory {
  // src/**/*.mjs: the forum core and CLI, JavaScript that Node runs as is, typed through JSDoc.
  core: string[]
  // src/**/*.d.mts: the consumer contract of each core module, next to it, and the type-only shapes.
  sidecars: string[]
  // extension/**/*.ts: the Pi extension, TypeScript that Pi's loader runs as is.
  extension: string[]
  // All of the above, sorted.
  shipped: string[]
  // Any other file under src/ or extension/, which should not be there.
  others: string[]
}

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

// The production directories: the core under src/ and the extension under extension/.
export const SOURCE_DIRS: readonly string[] = ['src', 'extension']

// Declarations of types alone, with no core module of their own.
export const TYPE_ONLY: readonly string[] = ['src/types.d.mts']

// The files a commit of the working tree would hold, as Git would clone them: tracked files that still
// exist and untracked files that are not ignored, sorted. node_modules and other ignored files are left
// out.
export async function checkoutFiles(root = ROOT): Promise<string[]> {
  const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
  const files = [...new Set(stdout.split('\0').filter(Boolean))].sort()
  const present = await Promise.all(files.map((file) => fs.lstat(path.join(root, file)).then((stat) => stat.isFile(), () => false)))
  return files.filter((_, i) => present[i])
}

// Copies those files, with their modes, into dest; returns the copied list.
export async function copyCheckout(dest: string, root = ROOT): Promise<string[]> {
  const files = await checkoutFiles(root)
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dest, file)), { recursive: true })
    await fs.copyFile(path.join(root, file), path.join(dest, file))
    await fs.chmod(path.join(dest, file), (await fs.stat(path.join(root, file))).mode & 0o777)
  }
  return files
}

// POSIX paths of the files under dir, sorted, skipping the named entries (such as a linked node_modules).
export async function listFiles(dir: string, { skip = [] }: { skip?: readonly string[] } = {}, prefix = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await fs.readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = path.posix.join(prefix, entry.name)
    if (skip.includes(name)) continue
    if (entry.isDirectory()) files.push(...(await listFiles(dir, { skip }, name)))
    else files.push(name)
  }
  return files.sort()
}

// Content hash, mode and modification time of every file under dir (or of the given files), so a
// comparison catches a rewrite even when it wrote the same bytes.
export async function snapshot(dir: string, { files, skip = [] }: { files?: readonly string[]; skip?: readonly string[] } = {}): Promise<Snapshot> {
  const result: Snapshot = {}
  for (const file of files ?? (await listFiles(dir, { skip }))) {
    const full = path.join(dir, file)
    const stat = await fs.stat(full).catch(() => null)
    result[file] = stat && {
      sha256: createHash('sha256').update(await fs.readFile(full)).digest('hex'),
      mode: stat.mode & 0o777,
      mtimeMs: stat.mtimeMs,
    }
  }
  return result
}

// The production sources in the given tree, by kind, from every file under the source directories.
export async function sourceInventory(root = ROOT): Promise<Inventory> {
  const inventory: Inventory = { core: [], sidecars: [], extension: [], shipped: [], others: [] }
  for (const dir of SOURCE_DIRS) {
    for (const name of await listFiles(path.join(root, dir))) {
      const file = `${dir}/${name}`
      if (dir === 'src' && file.endsWith('.d.mts')) inventory.sidecars.push(file)
      else if (dir === 'src' && file.endsWith('.mjs')) inventory.core.push(file)
      else if (dir === 'extension' && file.endsWith('.ts') && !/\.d\.[cm]?ts$/.test(file)) inventory.extension.push(file)
      else inventory.others.push(file)
    }
  }
  inventory.shipped = [...inventory.core, ...inventory.sidecars, ...inventory.extension].sort()
  return inventory
}

// The sidecar declaring a core module: src/X.d.mts for src/X.mjs.
export function sidecarOf(file: string): string {
  return file.replace(/\.mjs$/, '.d.mts')
}
