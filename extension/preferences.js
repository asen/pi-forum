import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import path from 'node:path';
export const PREFERENCES_FILE = 'forum.json';
export const SCOPES = ['user', 'project'];
export function createPreferenceStore({ getAgentDir, fs = nodeFs }) {
    function load(ctx) {
        const user = readScope('user', ctx);
        const project = readScope('project', ctx);
        if (project.enabled !== undefined)
            return { enabled: project.enabled, source: project.scope, user, project };
        if (user.enabled !== undefined)
            return { enabled: user.enabled, source: user.scope, user, project };
        return { enabled: undefined, source: null, user, project };
    }
    function set(scope, enabled, ctx) {
        if (typeof enabled !== 'boolean')
            throw new TypeError(`enabled must be a boolean, got ${typeof enabled}`);
        return update(scope, ctx, enabled);
    }
    function reset(scope, ctx) {
        return update(scope, ctx, undefined);
    }
    function readScope(scope, ctx) {
        const where = locate(scope, ctx);
        if (where.ignored)
            return { scope, path: where.path, exists: false, enabled: undefined, ignored: where.ignored, error: null };
        if (where.error)
            return { scope, path: where.path, exists: false, enabled: undefined, ignored: null, error: where.error };
        const file = readFile(where.path);
        if (file.error)
            return { scope, path: where.path, exists: file.exists, enabled: undefined, ignored: null, error: file.error };
        return { scope, path: where.path, exists: file.exists, enabled: file.data?.enabled, ignored: null, error: null };
    }
    function update(scope, ctx, enabled) {
        const where = locate(scope, ctx);
        const fail = (error) => ({ ok: false, scope, path: where.path, error });
        if (where.ignored) {
            const { code, message } = where.ignored;
            return fail({ code, message: `${message}; the project default was not changed` });
        }
        if (where.error)
            return fail(where.error);
        const file = readFile(where.path);
        if (file.error) {
            return fail({ code: file.error.code, message: `${file.error.message}; refusing to replace it, fix or remove it first` });
        }
        const saved = { ok: true, scope, path: where.path, enabled };
        if (file.data?.enabled === enabled)
            return { ...saved, changed: false };
        const data = { ...file.data };
        if (enabled === undefined)
            delete data.enabled;
        else
            data.enabled = enabled;
        const failure = writeAtomic(where.path, `${JSON.stringify(data, null, 2)}\n`);
        if (failure)
            return fail({ code: 'write-failed', message: failure });
        return { ...saved, changed: true };
    }
    function locate(scope, ctx) {
        if (scope === 'user') {
            try {
                return { path: path.resolve(getAgentDir(), PREFERENCES_FILE) };
            }
            catch (err) {
                return { path: null, error: { code: 'agent-dir-unavailable', message: `cannot locate the Pi agent directory: ${errorText(err)}` } };
            }
        }
        if (scope !== 'project')
            throw new TypeError(`unknown preference scope ${JSON.stringify(scope)}`);
        const cwd = ctx?.cwd;
        if (ctx == null || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
            return { path: null, ignored: { code: 'no-cwd', message: 'no absolute working directory is known for project preferences' } };
        }
        const file = path.join(cwd, '.pi', PREFERENCES_FILE);
        const trust = projectTrust(ctx);
        if (trust === true)
            return { path: file };
        if (trust === false) {
            const message = `project ${cwd} is not trusted, so ${file} is ignored; ` +
                'run /trust and restart Pi, or start Pi with --approve, to use project defaults';
            return { path: file, ignored: { code: 'untrusted', message } };
        }
        const message = `cannot confirm that project ${cwd} is trusted (${trust.reason}), so ${file} is ignored; ` +
            'run /trust and restart Pi, or start Pi with --approve, to use project defaults';
        return { path: file, ignored: { code: 'trust-unavailable', message } };
    }
    function readFile(file) {
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        }
        catch (err) {
            if (errorField(err, 'code') === 'ENOENT')
                return { exists: false, data: null };
            return { exists: true, error: { code: 'unreadable', message: `cannot read ${file}: ${errorText(err)}` } };
        }
        let data;
        try {
            data = JSON.parse(text);
        }
        catch (err) {
            return { exists: true, error: { code: 'malformed', message: `${file} is not valid JSON: ${errorText(err)}` } };
        }
        if (!isJsonObject(data)) {
            return { exists: true, error: { code: 'invalid', message: `${file} must contain a JSON object` } };
        }
        if (!isPreferenceData(data)) {
            return { exists: true, error: { code: 'invalid', message: `"enabled" in ${file} must be true or false, got ${JSON.stringify(data.enabled)}` } };
        }
        return { exists: true, data };
    }
    // Returns null once the rename succeeds, otherwise a message; the destination is never partly written.
    function writeAtomic(file, content) {
        const dir = path.dirname(file);
        const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
        let fd = null;
        let created = false;
        try {
            fs.mkdirSync(dir, { recursive: true });
            fd = fs.openSync(temp, 'wx');
            created = true;
            fs.writeFileSync(fd, content);
            fs.fsyncSync(fd);
            const closing = fd;
            fd = null;
            fs.closeSync(closing);
            fs.renameSync(temp, file);
            return null;
        }
        catch (err) {
            let message = `cannot save ${file}: ${errorText(err)}`;
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                }
                catch { }
            }
            if (created) {
                try {
                    fs.unlinkSync(temp);
                }
                catch (cleanup) {
                    if (errorField(cleanup, 'code') !== 'ENOENT')
                        message += `; the temporary file ${temp} could not be removed: ${errorText(cleanup)}`;
                }
            }
            return message;
        }
    }
    return { load, set, reset };
}
// true only when the context confirms trust; false when it denies it; { reason } when it cannot say.
function projectTrust(ctx) {
    if (typeof ctx.isProjectTrusted !== 'function')
        return { reason: 'this Pi does not report project trust' };
    // Typed as the host declares it, but checked like any other value a host might return.
    let trusted;
    try {
        trusted = ctx.isProjectTrusted();
    }
    catch (err) {
        return { reason: `the trust check failed: ${errorText(err)}` };
    }
    if (trusted === true)
        return true;
    if (trusted === false)
        return false;
    return { reason: `the trust check returned ${typeof trusted}` };
}
const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPreferenceData = (data) => !Object.hasOwn(data, 'enabled') || typeof data.enabled === 'boolean';
// err?.[name] for any thrown value, read exactly as JavaScript reads it: undefined for null and
// undefined, and otherwise the value's own or inherited property, if any.
function errorField(err, name) {
    // Asserted only to allow the property access; no value other than null or undefined fails it.
    return err == null ? undefined : err[name];
}
function errorText(err) {
    return errorField(err, 'message') ?? String(err);
}
