import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { MAX_BODY_BYTES, MAX_LABEL_CHARS } from './records.js'
import { createTopic, getTopic, listMessages, listTopics, postMessage } from './storage.js'

const HELP = `Usage:
  pi-forum topic create TITLE [BODY] [--author LABEL]
  pi-forum topic list [--after CURSOR] [--limit N]
  pi-forum topic get TOPIC_ID
  pi-forum message post TOPIC_ID BODY [--reply-to MESSAGE_ID] [--author LABEL]
  pi-forum message list [--topic TOPIC_ID] [--after CURSOR] [--limit N]

BODY is exactly one of:
  --body TEXT         inline text
  --body-file PATH    UTF-8 file; a relative PATH resolves from the current directory
  --body-stdin        UTF-8 text read from standard input
  Body text is stored exactly as given, up to ${MAX_BODY_BYTES / 1024} KiB of UTF-8. It is optional
  for topic create, where it becomes the topic's first message, and required for message post.

Options:
  --author LABEL      author label (default: $PI_SESSION_ID if set, otherwise "external")
  --reply-to ID       mark the message as a reply to a message in the same topic
  --topic TOPIC_ID    list only messages of this topic (default: activity across the forum)
  --after CURSOR      continue after the next_cursor of an earlier list result
  --limit N           page size from 1 to 100 (default: 20 topics, 50 messages)
  -h, --help          show this help

  Titles and author labels must be non-blank, up to ${MAX_LABEL_CHARS} characters.
  Put -- before a TITLE or ID that starts with "-"; use --body=TEXT for text that does.

Environment:
  PI_FORUM_DIR        required absolute path of the forum directory (created if missing)
  PI_SESSION_ID       default author; recorded as origin_session_id on new topics/messages

Output:
  Success prints one JSON object on stdout:
    topic create    {"topic": Topic, "message": Message | null}
    topic get       {"topic": Topic}
    message post    {"message": Message}
    topic list      {"items": [Topic, ...], "next_cursor": CURSOR}
    message list    {"items": [Message, ...], "next_cursor": CURSOR}
  Errors and warnings go to stderr; failures exit with status 1.

Pagination:
  Lists return items in creation order. Pass next_cursor as --after to read the next page.
  An empty page means you are caught up; keep its next_cursor to read only newer items later.
  Cursors are opaque and belong to one forum.
`

class UsageError extends Error {}

const BODY_OPTIONS = {
  body: { type: 'string' },
  'body-file': { type: 'string' },
  'body-stdin': { type: 'boolean' },
}
const LIST_OPTIONS = { after: { type: 'string' }, limit: { type: 'string' } }

// Each command: option definitions, positional argument names, and a handler.
const COMMANDS = {
  'topic create': {
    options: { ...BODY_OPTIONS, author: { type: 'string' } },
    args: ['TITLE'],
    body: 'optional',
    async run(forumDir, { TITLE }, values, env) {
      const body = await readBody(values)
      return createTopic(forumDir, { title: TITLE, body, ...attribution(values, env) })
    },
  },
  'topic list': {
    options: LIST_OPTIONS,
    args: [],
    run: (forumDir, _, values, env, onWarning) =>
      listTopics(forumDir, { after: values.after, limit: values.limit, onWarning }),
  },
  'topic get': {
    options: {},
    args: ['TOPIC_ID'],
    run: async (forumDir, { TOPIC_ID }, values, env, onWarning) => ({
      topic: await getTopic(forumDir, TOPIC_ID, { onWarning }),
    }),
  },
  'message post': {
    options: { ...BODY_OPTIONS, 'reply-to': { type: 'string' }, author: { type: 'string' } },
    args: ['TOPIC_ID'],
    body: 'required',
    async run(forumDir, { TOPIC_ID }, values, env, onWarning) {
      const body = await readBody(values)
      const input = { topicId: TOPIC_ID, body, replyTo: values['reply-to'], ...attribution(values, env) }
      return { message: await postMessage(forumDir, input, { onWarning }) }
    },
  },
  'message list': {
    options: { topic: { type: 'string' }, ...LIST_OPTIONS },
    args: [],
    run: (forumDir, _, values, env, onWarning) =>
      listMessages(forumDir, { topicId: values.topic, after: values.after, limit: values.limit, onWarning }),
  },
}

const HELP_FLAGS = ['--help', '-h']
const GROUPS = new Set(Object.keys(COMMANDS).map((name) => name.split(' ')[0]))

// Returns { help: true } or a validated { command, args, values }. Help is recognized only where
// the parser expects an option, so a value such as `--body --help` is still an argument error.
function parseCommand(argv) {
  if (argv[0] === 'help' || HELP_FLAGS.includes(argv[0])) return { help: true }
  if (GROUPS.has(argv[0]) && HELP_FLAGS.includes(argv[1])) return { help: true }
  const name = argv.slice(0, 2).join(' ')
  const command = COMMANDS[name]
  if (!command) throw new UsageError(argv.length === 0 ? 'missing command' : `unknown command "${name}"`)
  const options = Object.fromEntries(
    Object.entries(command.options).map(([key, option]) => [key, { ...option, multiple: true }]),
  )
  options.help = { type: 'boolean', short: 'h' }
  let parsed
  try {
    parsed = parseArgs({ args: argv.slice(2), options, allowPositionals: true, strict: true })
  } catch (err) {
    if (err.code?.startsWith('ERR_PARSE_ARGS_')) throw new UsageError(err.message)
    throw err
  }
  const { help = false, ...lists } = parsed.values
  const values = {}
  for (const [key, list] of Object.entries(lists)) {
    if (list.length > 1) throw new UsageError(`--${key} may be given only once`)
    values[key] = list[0]
  }
  // With --help, whatever is given must be valid, but missing arguments and body are allowed.
  const { positionals } = parsed
  if (!help && positionals.length < command.args.length) {
    throw new UsageError(`missing ${command.args[positionals.length]} for ${name}`)
  }
  if (positionals.length > command.args.length) {
    throw new UsageError(`unexpected argument "${positionals[command.args.length]}" for ${name}`)
  }
  if (command.body) checkBodySource(values, command.body === 'required' && !help)
  if (values.limit !== undefined) values.limit = parseLimit(values.limit)
  if (help) return { help }
  const args = Object.fromEntries(command.args.map((arg, i) => [arg, positionals[i]]))
  return { command, args, values }
}

function parseLimit(value) {
  if (!/^[0-9]+$/.test(value)) throw new UsageError('--limit must be an integer from 1 to 100')
  return Number(value)
}

// Explicit --author wins, then the caller's Pi session; origin is recorded only for a real session.
function attribution(values, env) {
  const session = env.PI_SESSION_ID?.trim() ? env.PI_SESSION_ID : undefined
  return { author: values.author ?? session ?? 'external', originSessionId: session }
}

function decode(bytes, source) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new UsageError(`body from ${source} is not valid UTF-8`)
  }
}

function checkBodySource(values, required) {
  const sources = Object.keys(BODY_OPTIONS).filter((key) => values[key] !== undefined)
  if (sources.length > 1) throw new UsageError(`use only one of ${sources.map((key) => `--${key}`).join(', ')}`)
  if (sources.length === 0 && required) {
    throw new UsageError('a body is required: use --body, --body-file or --body-stdin')
  }
}

// Reads the single body source chosen on the command line, if any.
async function readBody(values) {
  if (values.body !== undefined) return values.body
  if (values['body-file'] !== undefined) {
    const file = path.resolve(values['body-file'])
    let bytes
    try {
      bytes = await fs.readFile(file)
    } catch (err) {
      throw new Error(`cannot read body file ${file}: ${err.message}`, { cause: err })
    }
    return decode(bytes, file)
  }
  if (!values['body-stdin']) return undefined
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return decode(Buffer.concat(chunks), 'stdin')
}

function forumDirectory(env) {
  const dir = env.PI_FORUM_DIR
  if (!dir) throw new Error('PI_FORUM_DIR is not set; it must be the absolute path of the forum directory')
  if (!path.isAbsolute(dir)) throw new Error(`PI_FORUM_DIR must be an absolute path, got ${JSON.stringify(dir)}`)
  return dir
}

function describeError(err) {
  if (err.code === 'PARTIAL_WRITE') {
    const id = err.topic.id
    return (
      `topic ${id} was created, but its initial message may be missing (${err.cause?.message ?? err.message}).\n` +
      `Check with "pi-forum message list --topic ${id}" and, if needed, post the body with ` +
      `"pi-forum message post ${id} ..." instead of creating the topic again.`
    )
  }
  if (err instanceof UsageError) return `${err.message}\nRun "pi-forum --help" for usage.`
  return err.message
}

// Runs one CLI invocation and returns its exit status.
export async function main(argv, env = process.env) {
  const onWarning = (message) => process.stderr.write(`pi-forum: warning: ${message}\n`)
  try {
    const { help, command, args, values } = parseCommand(argv)
    if (help) {
      process.stdout.write(HELP)
      return 0
    }
    const result = await command.run(forumDirectory(env), args, values, env, onWarning)
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (err) {
    process.stderr.write(`pi-forum: error: ${describeError(err)}\n`)
    return 1
  }
}
