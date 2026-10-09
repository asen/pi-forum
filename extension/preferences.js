import { randomUUID } from 'node:crypto'
import nodeFs from 'node:fs'
import path from 'node:path'

export const PREFERENCES_FILE = 'forum.json'
export const SCOPES = ['user', 'project']

// Saved /forum activation defaults: <agent-dir>/forum.json for the user and <cwd>/.pi/forum.json for
// the project. Each file is a JSON object whose optional boolean "enabled" is the scope's default; a
// missing file or key inherits (project from user, user from built-in off) and false is an explicit
// off. Other fields are ignored here and kept on updates.
//
// The project file is looked up only in ctx.cwd, never in a repository root or ancestor, and only
// read or written while ctx.isProjectTrusted() returns true. A missing or throwing trust check fails
// closed for the project; the user scope needs no ctx.
//
// Everything is synchronous so session start can apply the result before anything else runs. A
// missing file is silent; an unreadable or invalid one is reported in load() and inherits, and
// updates refuse to replace it. Updates write an exclusive temporary file next to the destination
// and rename it over; the rename is the only point of success, and a failure before it leaves the
// destination untouched and removes the temporary file.
//
// load(ctx) returns { enabled, source, user, project }: enabled is the effective saved default
// (true, false or undefined to inherit the built-in default) and source the scope that set it, or
// null. Each scope state is { scope, path, exists, enabled, ignored, error }: ignored ({ code,
// message }) means the file was not consulted (project only: no-cwd, untrusted, trust-unavailable);
// error ({ code, message }) means it was consulted and could not be used (agent-dir-unavailable,
// unreadable, malformed, invalid).
//
// set(scope, enabled, ctx) and reset(scope, ctx) return { ok: true, scope, path, enabled, changed }
// with the scope's saved value afterward, or { ok: false, scope, path, error: { code, message } }
// with one of the codes above or write-failed. Unchanged values are not rewritten, and resetting a
// missing file creates nothing.
export function createPreferenceStore({ getAgentDir, fs = nodeFs }) {
  function load(ctx) {
    const user = readScope('user', ctx)
    const project = readScope('project', ctx)
    const from = project.enabled !== undefined ? project : user.enabled !== undefined ? user : null
    return { enabled: from?.enabled, source: from?.scope ?? null, user, project }
  }

  function set(scope, enabled, ctx) {
    if (typeof enabled !== 'boolean') throw new TypeError(`enabled must be a boolean, got ${typeof enabled}`)
    return update(scope, ctx, enabled)
  }

  function reset(scope, ctx) {
    return update(scope, ctx, undefined)
  }

  function readScope(scope, ctx) {
    const where = locate(scope, ctx)
    const state = { scope, path: where.path, exists: false, enabled: undefined, ignored: null, error: null }
    if (where.ignored) return { ...state, ignored: where.ignored }
    if (where.error) return { ...state, error: where.error }
    const file = readFile(where.path)
    if (file.error) return { ...state, exists: file.exists, error: file.error }
    return { ...state, exists: file.exists, enabled: file.data?.enabled }
  }

  function update(scope, ctx, enabled) {
    const where = locate(scope, ctx)
    const fail = (error) => ({ ok: false, scope, path: where.path, error })
    if (where.ignored) {
      const { code, message } = where.ignored
      return fail({ code, message: `${message}; the project default was not changed` })
    }
    if (where.error) return fail(where.error)
    const file = readFile(where.path)
    if (file.error) {
      return fail({ code: file.error.code, message: `${file.error.message}; refusing to replace it, fix or remove it first` })
    }
    const saved = { ok: true, scope, path: where.path, enabled }
    if (file.data?.enabled === enabled) return { ...saved, changed: false }
    const data = { ...file.data }
    if (enabled === undefined) delete data.enabled
    else data.enabled = enabled
    const failure = writeAtomic(where.path, `${JSON.stringify(data, null, 2)}\n`)
    if (failure) return fail({ code: 'write-failed', message: failure })
    return { ...saved, changed: true }
  }

  // { path } for a scope that can be used, or the path (if known) with ignored or error.
  function locate(scope, ctx) {
    if (scope === 'user') {
      try {
        return { path: path.resolve(getAgentDir(), PREFERENCES_FILE) }
      } catch (err) {
        return { path: null, error: { code: 'agent-dir-unavailable', message: `cannot locate the Pi agent directory: ${errorText(err)}` } }
      }
    }
    if (scope !== 'project') throw new TypeError(`unknown preference scope ${JSON.stringify(scope)}`)
    const cwd = ctx?.cwd
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      return { path: null, ignored: { code: 'no-cwd', message: 'no absolute working directory is known for project preferences' } }
    }
    const file = path.join(cwd, '.pi', PREFERENCES_FILE)
    const trust = projectTrust(ctx)
    if (trust === true) return { path: file }
    if (trust === false) {
      const message =
        `project ${cwd} is not trusted, so ${file} is ignored; ` +
        'run /trust and restart Pi, or start Pi with --approve, to use project defaults'
      return { path: file, ignored: { code: 'untrusted', message } }
    }
    const message =
      `cannot confirm that project ${cwd} is trusted (${trust.reason}), so ${file} is ignored; ` +
      'run /trust and restart Pi, or start Pi with --approve, to use project defaults'
    return { path: file, ignored: { code: 'trust-unavailable', message } }
  }

  // { exists, data } for a missing (data null) or valid file, or { exists, error }.
  function readFile(file) {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (err) {
      if (err?.code === 'ENOENT') return { exists: false, data: null }
      return { exists: true, error: { code: 'unreadable', message: `cannot read ${file}: ${errorText(err)}` } }
    }
    let data
    try {
      data = JSON.parse(text)
    } catch (err) {
      return { exists: true, error: { code: 'malformed', message: `${file} is not valid JSON: ${errorText(err)}` } }
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { exists: true, error: { code: 'invalid', message: `${file} must contain a JSON object` } }
    }
    if (Object.hasOwn(data, 'enabled') && typeof data.enabled !== 'boolean') {
      return { exists: true, error: { code: 'invalid', message: `"enabled" in ${file} must be true or false, got ${JSON.stringify(data.enabled)}` } }
    }
    return { exists: true, data }
  }

  // Returns null once the rename succeeds, otherwise a message; the destination is never partly written.
  function writeAtomic(file, content) {
    const dir = path.dirname(file)
    const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`)
    let fd = null
    let created = false
    try {
      fs.mkdirSync(dir, { recursive: true })
      fd = fs.openSync(temp, 'wx')
      created = true
      fs.writeFileSync(fd, content)
      fs.fsyncSync(fd)
      const closing = fd
      fd = null
      fs.closeSync(closing)
      fs.renameSync(temp, file)
      return null
    } catch (err) {
      let message = `cannot save ${file}: ${errorText(err)}`
      if (fd !== null) {
        try {
          fs.closeSync(fd)
        } catch {}
      }
      if (created) {
        try {
          fs.unlinkSync(temp)
        } catch (cleanup) {
          if (cleanup?.code !== 'ENOENT') message += `; the temporary file ${temp} could not be removed: ${errorText(cleanup)}`
        }
      }
      return message
    }
  }

  return { load, set, reset }
}

// true only when the context confirms trust; false when it denies it; { reason } when it cannot say.
function projectTrust(ctx) {
  if (typeof ctx.isProjectTrusted !== 'function') return { reason: 'this Pi does not report project trust' }
  let trusted
  try {
    trusted = ctx.isProjectTrusted()
  } catch (err) {
    return { reason: `the trust check failed: ${errorText(err)}` }
  }
  if (trusted === true) return true
  if (trusted === false) return false
  return { reason: `the trust check returned ${typeof trusted}` }
}

function errorText(err) {
  return err?.message ?? String(err)
}
