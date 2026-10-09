// Scratch copies of this checkout, for tests that build, pack or install it without touching the
// working tree.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

// The production directories whose X.ts each own a generated X.js and X.d.ts next to it.
export const SOURCE_DIRS = ['src', 'src/backends', 'extension']

// The files a commit of the working tree would hold, as Git would clone them: tracked files that still
// exist and untracked files that are not ignored, sorted. node_modules and other ignored files are left
// out.
export async function checkoutFiles(root = ROOT) {
  const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root })
  const files = [...new Set(stdout.split('\0').filter(Boolean))].sort()
  const present = await Promise.all(files.map((file) => fs.lstat(path.join(root, file)).then((stat) => stat.isFile(), () => false)))
  return files.filter((_, i) => present[i])
}

// Copies those files, with their modes, into dest; returns the copied list.
export async function copyCheckout(dest, root = ROOT) {
  const files = await checkoutFiles(root)
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dest, file)), { recursive: true })
    await fs.copyFile(path.join(root, file), path.join(dest, file))
    await fs.chmod(path.join(dest, file), (await fs.stat(path.join(root, file))).mode & 0o777)
  }
  return files
}

// POSIX paths of the files under dir, sorted, skipping the named entries (such as a linked node_modules).
export async function listFiles(dir, { skip = [] } = {}, prefix = '') {
  const files = []
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
export async function snapshot(dir, { files, skip = [] } = {}) {
  const result = {}
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

// Production TypeScript sources and the generated files they own, from the given tree.
export async function generatedInventory(root = ROOT) {
  const sources = []
  for (const dir of SOURCE_DIRS) {
    for (const name of await fs.readdir(path.join(root, dir))) {
      if (name.endsWith('.ts') && !name.endsWith('.d.ts')) sources.push(`${dir}/${name}`)
    }
  }
  sources.sort()
  const generated = sources.flatMap((file) => ['.js', '.d.ts'].map((ext) => file.slice(0, -'.ts'.length) + ext)).sort()
  return { sources, generated }
}
