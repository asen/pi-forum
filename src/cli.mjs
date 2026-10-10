import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createForum } from './forum.mjs'
import { MAX_BODY_BYTES, MAX_LABEL_CHARS, errorMessage } from './records.mjs'

/**
 * @import { ParseArgsOptionsConfig } from 'node:util'
 * @import { CreateTopicResult, Forum, Message, Page, Topic, WarningHandler } from './types.d.mts'
 * @import { Environment, MainOptions } from './cli.d.mts'
 */

const HELP = `Usage:
  pi-forum topic create TITLE [BODY] [--author LABEL]
  pi-forum topic list [--after CURSOR] [--limit N]
  pi-forum topic get TOPIC_ID
  pi-forum message post TOPIC_ID BODY [--reply-to MESSAGE_ID] [--author LABEL]
  pi-forum message list [--topic TOPIC_ID] [--after CURSOR] [--limit N]
  pi-forum message get MESSAGE_ID

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
    message get     {"message": Message}
    topic list      {"items": [Topic, ...], "next_cursor": CURSOR}
    message list    {"items": [Message, ...], "next_cursor": CURSOR}
  Errors and warnings go to stderr; failures exit with status 1.

Pagination:
  Lists return items in creation order. Pass next_cursor as --after to read the next page.
  An empty page means you are caught up; keep its next_cursor to read only newer items later.
  Cursors are opaque and belong to one forum.
`

class UsageError extends Error {}

// Every option a command may accept, with its parseArgs type.
const OPTION_TYPES = /** @type {const} */ ({
  body: 'string',
  'body-file': 'string',
  'body-stdin': 'boolean',
  author: 'string',
  'reply-to': 'string',
  topic: 'string',
  after: 'string',
  limit: 'string',
})

/** @typedef {keyof typeof OPTION_TYPES} OptionName */
/**
 * @template {OptionName} K
 * @typedef {(typeof OPTION_TYPES)[K] extends 'string' ? string : boolean} OptionValue
 */
// A command's parseArgs definitions, each typed as above.
/** @typedef {{ readonly [K in OptionName]?: { readonly type: (typeof OPTION_TYPES)[K] } }} OptionDefinitions */

// Option values as given on the command line, so --limit is still its raw text.
/** @typedef {{ readonly [K in OptionName]?: OptionValue<K> | undefined }} RawValues */

// Option values once validated, with --limit as a number.
/** @typedef {Omit<RawValues, 'limit'> & { readonly limit?: number | undefined }} CommandValues */

/** @typedef {'TITLE' | 'TOPIC_ID' | 'MESSAGE_ID'} ArgName */
/**
 * @template {ArgName} A
 * @typedef {{ readonly [K in A]: string }} CommandArgs
 */

/** @typedef {CreateTopicResult | { topic: Topic } | { message: Message } | Page<Topic> | Page<Message>} CommandResult */

// Each command: accepted options, positional argument names, whether it takes a body, and a handler
// that runs against the invocation's bound forum client.
/**
 * @template {ArgName} [A=ArgName]
 * @typedef {{
 *   options: OptionDefinitions
 *   args: readonly A[]
 *   body?: 'optional' | 'required'
 *   run(forum: Forum, args: CommandArgs<A>, values: CommandValues, env: Environment, onWarning: WarningHandler): Promise<CommandResult>
 * }} CommandSpec
 */

// Checks a handler against its own argument names.
/**
 * @template {ArgName} A
 * @param {CommandSpec<A>} spec
 * @returns {CommandSpec}
 */
const command = (spec) => spec

// parseCommand's result: a help request, or a validated command to run.
/** @typedef {{ help: true }} HelpRequest */

/** @typedef {{ help: false, command: CommandSpec, args: CommandArgs<ArgName>, values: CommandValues }} CommandInvocation */

const BODY_OPTIONS = /** @satisfies {OptionDefinitions} */ (
  /** @type {const} */ ({
    body: { type: 'string' },
    'body-file': { type: 'string' },
    'body-stdin': { type: 'boolean' },
  })
)
const BODY_SOURCES = /** @satisfies {readonly (keyof typeof BODY_OPTIONS)[]} */ (
  /** @type {const} */ (['body', 'body-file', 'body-stdin'])
)
const LIST_OPTIONS = /** @satisfies {OptionDefinitions} */ (
  /** @type {const} */ ({ after: { type: 'string' }, limit: { type: 'string' } })
)
const BODY_REQUIRED = 'a body is required: use --body, --body-file or --body-stdin'

/** @type {{ readonly [name: string]: CommandSpec }} */
const COMMANDS = {
  'topic create': command({
    options: { ...BODY_OPTIONS, author: { type: 'string' } },
    args: ['TITLE'],
    body: 'optional',
    async run(forum, { TITLE }, values, env, onWarning) {
      const body = await readBody(values)
      return forum.createTopic({ title: TITLE, body, ...attribution(values, env) }, { onWarning })
    },
  }),
  'topic list': command({
    options: LIST_OPTIONS,
    args: [],
    run: (forum, _, values, env, onWarning) => forum.listTopics({ after: values.after, limit: values.limit, onWarning }),
  }),
  'topic get': command({
    options: {},
    args: ['TOPIC_ID'],
    run: async (forum, { TOPIC_ID }, values, env, onWarning) => ({
      topic: await forum.getTopic(TOPIC_ID, { onWarning }),
    }),
  }),
  'message post': command({
    options: { ...BODY_OPTIONS, 'reply-to': { type: 'string' }, author: { type: 'string' } },
    args: ['TOPIC_ID'],
    body: 'required',
    async run(forum, { TOPIC_ID }, values, env, onWarning) {
      const body = await readBody(values)
      // parseCommand already required a body source, so this never fails.
      if (body === undefined) throw new UsageError(BODY_REQUIRED)
      const input = { topicId: TOPIC_ID, body, replyTo: values['reply-to'], ...attribution(values, env) }
      return { message: await forum.postMessage(input, { onWarning }) }
    },
  }),
  'message list': command({
    options: { topic: { type: 'string' }, ...LIST_OPTIONS },
    args: [],
    run: (forum, _, values, env, onWarning) =>
      forum.listMessages({ topicId: values.topic, after: values.after, limit: values.limit, onWarning }),
  }),
  'message get': command({
    options: {},
    args: ['MESSAGE_ID'],
    run: async (forum, { MESSAGE_ID }, values, env, onWarning) => ({
      message: await forum.getMessage(MESSAGE_ID, { onWarning }),
    }),
  }),
}

/**
 * @param {string | undefined} arg
 * @returns {boolean}
 */
const isHelpFlag = (arg) => arg === '--help' || arg === '-h'
const GROUPS = new Set(Object.keys(COMMANDS).map((name) => name.split(' ')[0]))

// Returns a help request or a validated command. Help is recognized only where the parser expects
// an option, so a value such as `--body --help` is still an argument error.
/**
 * @param {readonly string[]} argv
 * @returns {HelpRequest | CommandInvocation}
 */
function parseCommand(argv) {
  if (argv[0] === 'help' || isHelpFlag(argv[0])) return { help: true }
  if (GROUPS.has(argv[0]) && isHelpFlag(argv[1])) return { help: true }
  const name = argv.slice(0, 2).join(' ')
  const command = COMMANDS[name]
  if (!command) throw new UsageError(argv.length === 0 ? 'missing command' : `unknown command "${name}"`)
  /** @type {ParseArgsOptionsConfig} */
  const options = Object.fromEntries(
    Object.entries(command.options).map(([key, option]) => [key, { ...option, multiple: true }]),
  )
  options.help = { type: 'boolean', short: 'h' }
  let parsed
  try {
    parsed = parseArgs({ args: argv.slice(2), options, allowPositionals: true, strict: true })
  } catch (err) {
    if (err instanceof Error && 'code' in err && typeof err.code === 'string' && err.code.startsWith('ERR_PARSE_ARGS_')) {
      throw new UsageError(err.message)
    }
    throw err
  }
  // parseArgs types options built at run time loosely. Strict parsing admits only the command's
  // options and help, and every option is multiple, so each holds a list of its type's values.
  const { help = false, ...lists } =
    /** @type {{ readonly help?: boolean } & { readonly [K in OptionName]?: readonly OptionValue<K>[] }} */ (parsed.values)
  for (const [key, list] of Object.entries(lists)) {
    if (list.length > 1) throw new UsageError(`--${key} may be given only once`)
  }
  /** @type {RawValues} */
  const raw = {
    body: lists.body?.[0],
    'body-file': lists['body-file']?.[0],
    'body-stdin': lists['body-stdin']?.[0],
    author: lists.author?.[0],
    'reply-to': lists['reply-to']?.[0],
    topic: lists.topic?.[0],
    after: lists.after?.[0],
    limit: lists.limit?.[0],
  }
  // With --help, whatever is given must be valid, but missing arguments and body are allowed.
  const { positionals } = parsed
  if (!help && positionals.length < command.args.length) {
    throw new UsageError(`missing ${command.args[positionals.length]} for ${name}`)
  }
  if (positionals.length > command.args.length) {
    throw new UsageError(`unexpected argument "${positionals[command.args.length]}" for ${name}`)
  }
  if (command.body) checkBodySource(raw, command.body === 'required' && !help)
  /** @type {CommandValues} */
  const values = { ...raw, limit: raw.limit === undefined ? undefined : parseLimit(raw.limit) }
  if (help) return { help }
  // Every argument has its positional, as the counts were checked above.
  const args = /** @type {CommandArgs<ArgName>} */ (Object.fromEntries(command.args.map((arg, i) => [arg, positionals[i]])))
  return { help, command, args, values }
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseLimit(value) {
  if (!/^[0-9]+$/.test(value)) throw new UsageError('--limit must be an integer from 1 to 100')
  return Number(value)
}

// Explicit --author wins, then the caller's Pi session; origin is recorded only for a real session.
/**
 * @param {CommandValues} values
 * @param {Environment} env
 * @returns {{ author: string, originSessionId: string | undefined }}
 */
function attribution(values, env) {
  const session = env.PI_SESSION_ID?.trim() ? env.PI_SESSION_ID : undefined
  return { author: values.author ?? session ?? 'external', originSessionId: session }
}

/**
 * @param {Uint8Array} bytes
 * @param {string} source
 * @returns {string}
 */
function decode(bytes, source) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new UsageError(`body from ${source} is not valid UTF-8`)
  }
}

/**
 * @param {RawValues} values
 * @param {boolean} required
 * @returns {void}
 */
function checkBodySource(values, required) {
  const sources = BODY_SOURCES.filter((key) => values[key] !== undefined)
  if (sources.length > 1) throw new UsageError(`use only one of ${sources.map((key) => `--${key}`).join(', ')}`)
  if (sources.length === 0 && required) {
    throw new UsageError(BODY_REQUIRED)
  }
}

// Reads the single body source chosen on the command line, if any.
/**
 * @param {CommandValues} values
 * @returns {Promise<string | undefined>}
 */
async function readBody(values) {
  if (values.body !== undefined) return values.body
  if (values['body-file'] !== undefined) {
    const file = path.resolve(values['body-file'])
    let bytes
    try {
      bytes = await fs.readFile(file)
    } catch (err) {
      throw new Error(`cannot read body file ${file}: ${errorMessage(err)}`, { cause: err })
    }
    return decode(bytes, file)
  }
  if (!values['body-stdin']) return undefined
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return decode(Buffer.concat(chunks), 'stdin')
}

/**
 * @param {Environment} env
 * @returns {string}
 */
function forumDirectory(env) {
  const dir = env.PI_FORUM_DIR
  if (!dir) throw new Error('PI_FORUM_DIR is not set; it must be the absolute path of the forum directory')
  if (!path.isAbsolute(dir)) throw new Error(`PI_FORUM_DIR must be an absolute path, got ${JSON.stringify(dir)}`)
  return dir
}

// What describeError reads of a thrown value. Asserted only to allow JavaScript's property reads:
// a thrown null or undefined still fails reading code, and a partial write without a topic fails
// reading its id.
/**
 * @typedef {object} ThrownFields
 * @property {unknown} [code]
 * @property {{ readonly id: unknown }} topic
 * @property {unknown} [cause]
 */

/**
 * @param {unknown} err
 * @returns {unknown}
 */
function describeError(err) {
  const thrown = /** @type {Readonly<ThrownFields>} */ (err)
  if (thrown.code === 'PARTIAL_WRITE') {
    const id = thrown.topic.id
    const { cause } = thrown
    const causeMessage = cause == null ? undefined : errorMessage(cause)
    return (
      `topic ${id} was created, but its initial message may be missing (${causeMessage ?? errorMessage(err)}).\n` +
      `Check with "pi-forum message list --topic ${id}" and, if needed, post the body with ` +
      `"pi-forum message post ${id} ..." instead of creating the topic again.`
    )
  }
  if (err instanceof UsageError) return `${err.message}\nRun "pi-forum --help" for usage.`
  return errorMessage(err)
}

// Runs one CLI invocation and returns its exit status. Commands run against one forum client bound
// for the invocation by options.createForum, and output goes to options.stdout and options.stderr;
// the defaults are the shared API and the process streams, and tests may inject others. Reads create
// a missing forum directory, as they always have.
/**
 * @param {readonly string[]} argv
 * @param {Environment} [env]
 * @param {MainOptions} [options]
 * @returns {Promise<number>}
 */
export async function main(
  argv,
  env = process.env,
  { createForum: bind = createForum, stdout = process.stdout, stderr = process.stderr } = {},
) {
  /** @type {WarningHandler} */
  const onWarning = (message) => stderr.write(`pi-forum: warning: ${message}\n`)
  try {
    const parsed = parseCommand(argv)
    if (parsed.help) {
      stdout.write(HELP)
      return 0
    }
    const { command, args, values } = parsed
    const forum = bind({ forumDir: forumDirectory(env), createOnRead: true })
    const result = await command.run(forum, args, values, env, onWarning)
    stdout.write(`${JSON.stringify(result)}\n`)
    return 0
  } catch (err) {
    stderr.write(`pi-forum: error: ${describeError(err)}\n`)
    return 1
  }
}
