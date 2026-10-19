import fs from 'node:fs/promises'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createForum } from './forum.mjs'
import { MAX_BODY_BYTES, MAX_LABEL_CHARS, errorMessage } from './records.mjs'

/**
 * @import { ParseArgsOptionsConfig } from 'node:util'
 * @import { CreateTopicResult, Forum, Message, Page, SearchHit, Topic, WarningHandler } from './types.d.mts'
 * @import { Environment, MainOptions } from './cli.d.mts'
 */

const HELP = `Usage:
  pi-forum topic create TITLE [BODY] [--author LABEL]
  pi-forum topic list [--latest | --after CURSOR] [--limit N]
  pi-forum topic get TOPIC_ID
  pi-forum message post TOPIC_ID BODY [--reply-to MESSAGE_ID] [--author LABEL]
  pi-forum message list [--topic TOPIC_ID] [--latest | --after CURSOR] [--limit N]
  pi-forum message get MESSAGE_ID [--offset N]
  pi-forum search QUERY [--topic TOPIC_ID] [--latest | --after CURSOR] [--limit N]
  All commands accept --max-bytes N or --full.

BODY is exactly one of:
  --body TEXT         inline text
  --body-file PATH    UTF-8 file; a relative PATH resolves from the current directory
  --body-stdin        UTF-8 text read from standard input
  Body text is stored exactly as given, up to ${MAX_BODY_BYTES / 1024} KiB of UTF-8. It is optional
  for topic create, where it becomes the topic's first message, and required for message post.

QUERY is one argument, so quote it for the shell:
  pi-forum search '"flaky tests" AND (timeout OR deadlock) NOT resolved' --limit 20
  It matches topic titles and message bodies, each on its own, ignoring case. A term is a bare
  word, which matches text containing it, or a "double-quoted phrase", in which \\" and \\\\ escape.
  NOT, AND and OR (in any case, binding in that order) combine terms; adjacent terms are ANDed
  and parentheses group. Everything else is literal text.

Options:
  --author LABEL      author label (default: $PI_SESSION_ID if set, otherwise "external")
  --reply-to ID       mark the message as a reply to a message in the same topic
  --topic TOPIC_ID    restrict message listing or search to this topic (default: whole forum)
  --after CURSOR      continue after the next_cursor of an earlier list or search result
  --limit N           page size from 1 to 100 (default: 20 topics or search hits, 50 messages)
  --latest            last N matches, in append order; excludes --after
  --max-bytes N       stdout UTF-8 byte cap, including JSON framing (default: 30000; minimum: 2048)
  --offset N          message get: Unicode code-point offset (default: 0); use next_offset
  --full              complete records, no byte cap or preview; excludes --max-bytes and --offset
  -h, --help          show this help

  Titles and author labels must be non-blank, up to ${MAX_LABEL_CHARS} characters.
  Put -- before a TITLE, ID or QUERY that starts with "-"; use --body=TEXT for text that does.

Environment:
  PI_FORUM_DIR        required absolute path; reads require an existing directory, writes create it
  PI_SESSION_ID       default author; recorded as origin_session_id on new topics/messages

Output:
  Success prints one JSON object on stdout:
    topic create / message post: {"topic_id": ID, "message_id": ID | null} (write receipts)
    topic get: {"topic": Topic}
    message get: {"message": MessageChunk, "body_bytes": N, "offset": N, "next_offset": N | null}
    lists / search: {"items": [...], "next_cursor": CURSOR, "has_more": BOOLEAN}
  Latest-N pages also report older_omitted: the number of older matching records left out.
  List/search messages contain a body preview, body_bytes, and body_truncated. Previews are at
  most 512 code points and shrink to fit the byte cap; metadata and records are never silently
  dropped. If metadata alone cannot fit, reduce --limit or increase --max-bytes.
  Search hits remain {"type": "topic", "topic": Topic} or {"type": "message", "message": Preview}.
  Read a preview's full body with message get; continue with --offset NEXT_OFFSET until null.
  --full returns complete records: write results are {"topic", "message"} or {"message"},
  message get is {"message"}, and list/search bodies are complete. Redirect large full output
  to a file rather than sending it through a truncating tool.
  Errors and warnings go to stderr; failures exit with status 1.

Pagination:
  Lists return items in creation order. Pass next_cursor as --after to read the next page.
  Stop when has_more is false; keep next_cursor for later updates. It is always present,
  even at the end. has_more describes this snapshot, not future posts. Do not poll in a loop.
  --latest scans once, retains only N matches, and returns an end cursor for future updates;
  it does not page backwards. Omit --latest when continuing with --after.
  Cursors belong to one forum, not a query or topic filter; omit --after to search earlier records.
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
  latest: 'boolean',
  full: 'boolean',
  'max-bytes': 'string',
  offset: 'string',
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

// Option values once validated, with numeric options parsed.
/** @typedef {Omit<RawValues, 'limit' | 'offset' | 'max-bytes'> & {
 *   readonly limit?: number | undefined,
 *   readonly offset?: number | undefined,
 *   readonly 'max-bytes'?: number | undefined
 * }} CommandValues */

/** @typedef {'TITLE' | 'TOPIC_ID' | 'MESSAGE_ID' | 'QUERY'} ArgName */
/**
 * @template {ArgName} A
 * @typedef {{ readonly [K in A]: string }} CommandArgs
 */

/**
 * @typedef {CreateTopicResult | { topic: Topic } | { message: Message } | Page<Topic> | Page<Message> | Page<SearchHit>} CommandResult
 */

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

/** @typedef {{ help: false, name: string, command: CommandSpec, args: CommandArgs<ArgName>, values: CommandValues }} CommandInvocation */

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
  /** @type {const} */ ({ after: { type: 'string' }, limit: { type: 'string' }, latest: { type: 'boolean' } })
)
const BODY_REQUIRED = 'a body is required: use --body, --body-file or --body-stdin'
const OUTPUT_OPTIONS = /** @satisfies {OptionDefinitions} */ (
  /** @type {const} */ ({ full: { type: 'boolean' }, 'max-bytes': { type: 'string' } })
)
const DEFAULT_MAX_BYTES = 30000
const PREVIEW_CHARS = 512

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
    run: (forum, _, values, env, onWarning) =>
      forum.listTopics({ after: values.after, limit: values.limit, ...(values.latest ? { latest: true } : {}), onWarning }),
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
      forum.listMessages({ topicId: values.topic, after: values.after, limit: values.limit, ...(values.latest ? { latest: true } : {}), onWarning }),
  }),
  'message get': command({
    options: { offset: { type: 'string' } },
    args: ['MESSAGE_ID'],
    run: async (forum, { MESSAGE_ID }, values, env, onWarning) => ({
      message: await forum.getMessage(MESSAGE_ID, { onWarning }),
    }),
  }),
  search: command({
    options: { topic: { type: 'string' }, ...LIST_OPTIONS },
    args: ['QUERY'],
    run: (forum, { QUERY }, values, env, onWarning) =>
      forum.search(QUERY, { topicId: values.topic, after: values.after, limit: values.limit, ...(values.latest ? { latest: true } : {}), onWarning }),
  }),
}

/**
 * @param {string | undefined} arg
 * @returns {boolean}
 */
const isHelpFlag = (arg) => arg === '--help' || arg === '-h'
// Commands are named by one word, as search is, or by a group word and a verb, as topic list is.
const SINGLE = new Set(Object.keys(COMMANDS).filter((name) => !name.includes(' ')))
const GROUPS = new Set(
  Object.keys(COMMANDS)
    .filter((name) => name.includes(' '))
    .map((name) => name.split(' ')[0]),
)

// Returns a help request or a validated command. Help is recognized only where the parser expects
// an option, so a value such as `--body --help` is still an argument error.
/**
 * @param {readonly string[]} argv
 * @returns {HelpRequest | CommandInvocation}
 */
function parseCommand(argv) {
  if (argv[0] === 'help' || isHelpFlag(argv[0])) return { help: true }
  if (GROUPS.has(argv[0]) && isHelpFlag(argv[1])) return { help: true }
  const words = SINGLE.has(argv[0] ?? '') ? 1 : 2
  const name = argv.slice(0, words).join(' ')
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!command) throw new UsageError(argv.length === 0 ? 'missing command' : `unknown command "${name}"`)
  /** @type {ParseArgsOptionsConfig} */
  const options = Object.fromEntries(
    Object.entries({ ...command.options, ...OUTPUT_OPTIONS }).map(([key, option]) => [key, { ...option, multiple: true }]),
  )
  options.help = { type: 'boolean', short: 'h' }
  let parsed
  try {
    parsed = parseArgs({ args: argv.slice(words), options, allowPositionals: true, strict: true })
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
    latest: lists.latest?.[0],
    full: lists.full?.[0],
    'max-bytes': lists['max-bytes']?.[0],
    offset: lists.offset?.[0],
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
  const values = {
    ...raw,
    limit: raw.limit === undefined ? undefined : parseLimit(raw.limit),
    offset: raw.offset === undefined ? undefined : parseInteger(raw.offset, '--offset', 0),
    'max-bytes': raw['max-bytes'] === undefined ? undefined : parseInteger(raw['max-bytes'], '--max-bytes', 2048),
  }
  if (raw.latest && raw.after !== undefined) throw new UsageError('--latest cannot be combined with --after')
  if (raw.full && (raw.offset !== undefined || raw['max-bytes'] !== undefined)) {
    throw new UsageError('--full cannot be combined with --offset or --max-bytes')
  }
  if (help) return { help }
  // Every argument has its positional, as the counts were checked above.
  const args = /** @type {CommandArgs<ArgName>} */ (Object.fromEntries(command.args.map((arg, i) => [arg, positionals[i]])))
  return { help, name, command, args, values }
}

/**
 * @param {string} value
 * @returns {number}
 */
function parseLimit(value) {
  if (!/^[0-9]+$/.test(value)) throw new UsageError('--limit must be an integer from 1 to 100')
  return Number(value)
}

/**
 * @param {string} value
 * @param {string} name
 * @param {number} minimum
 * @returns {number}
 */
function parseInteger(value, name, minimum) {
  const number = Number(value)
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new UsageError(`${name} must be a safe integer of at least ${minimum}`)
  }
  return number
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

// Output budgeting is presentation-only: it never changes a page's items or cursor.
// Previews shrink together; IDs and other metadata remain intact. Full output is an explicit opt-out.
/** @param {unknown} value */
const jsonLine = (value) => `${JSON.stringify(value)}\n`

/**
 * @param {(length: number) => unknown} render
 * @param {number} maximum
 * @param {number} maxBytes
 * @returns {{ text: string, length: number }}
 */
function fit(render, maximum, maxBytes) {
  const whole = jsonLine(render(maximum))
  if (Buffer.byteLength(whole) <= maxBytes) return { text: whole, length: maximum }
  let text = jsonLine(render(0))
  if (Buffer.byteLength(text) > maxBytes) {
    throw new UsageError('metadata alone exceeds --max-bytes; reduce --limit, increase --max-bytes, or redirect --full output to a file')
  }
  let low = 0
  let high = maximum
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = jsonLine(render(middle))
    if (Buffer.byteLength(candidate) <= maxBytes) {
      low = middle
      text = candidate
    } else high = middle - 1
  }
  return { text, length: low }
}

/** @param {string} text @param {number} length */
function prefix(text, length) {
  let end = 0
  let count = 0
  for (const character of text) {
    if (count++ === length) break
    end += character.length
  }
  return text.slice(0, end)
}

/** @param {Message} message @param {number} length */
function preview(message, length) {
  const body = prefix(message.body, length)
  return { ...message, body, body_bytes: Buffer.byteLength(message.body), body_truncated: body.length < message.body.length }
}

/** @param {CommandResult} result @param {number} length */
function previews(result, length) {
  if (!('items' in result)) return result
  const items = result.items.map((item) => {
    if ('body' in item) return preview(item, length)
    if ('type' in item && item.type === 'message') return { ...item, message: preview(item.message, length) }
    return item
  })
  return { ...result, items }
}

/** @param {Message} message @param {number} offset @param {number} maxBytes */
function messageChunk(message, offset, maxBytes) {
  const characters = [...message.body]
  if (offset > characters.length) throw new UsageError('--offset is past the end of the message')
  const remaining = characters.length - offset
  const body_bytes = Buffer.byteLength(message.body)
  const fitted = fit((length) => ({
    message: { ...message, body: characters.slice(offset, offset + length).join('') },
    body_bytes,
    offset,
    next_offset: length === remaining ? null : offset + length,
  }), remaining, maxBytes)
  if (remaining > 0 && fitted.length === 0) throw new UsageError('--max-bytes cannot fit one body character after metadata; increase it')
  return fitted.text
}

/** @param {string} name @param {CommandResult} result @param {CommandValues} values */
function present(name, result, values) {
  if (values.full) return jsonLine(result)
  const maxBytes = values['max-bytes'] ?? DEFAULT_MAX_BYTES
  if (name === 'message get' && 'message' in result && result.message) {
    return messageChunk(result.message, values.offset ?? 0, maxBytes)
  }
  // Receipts avoid echoing large posted bodies. Their validated IDs fit even the minimum budget,
  // so output budgeting cannot turn a completed write into an apparent failure.
  if (name === 'topic create' && 'topic' in result && 'message' in result) {
    return jsonLine({ topic_id: result.topic.id, message_id: result.message?.id ?? null })
  }
  if (name === 'message post' && 'message' in result && result.message) {
    return jsonLine({ topic_id: result.message.topic_id, message_id: result.message.id })
  }
  return fit((length) => previews(result, length), PREVIEW_CHARS, maxBytes).text
}

// Runs one CLI invocation and returns its exit status. Commands run against one forum client bound
// for the invocation by options.createForum, and output goes to options.stdout and options.stderr;
// the defaults are the shared API and the process streams, and tests may inject others. Reads never
// create storage: a missing directory is an error, not an empty forum.
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
    const { name, command, args, values } = parsed
    const forum = bind({ forumDir: forumDirectory(env), createOnRead: false })
    const result = await command.run(forum, args, values, env, onWarning)
    stdout.write(present(name, result, values))
    return 0
  } catch (err) {
    stderr.write(`pi-forum: error: ${describeError(err)}\n`)
    return 1
  }
}
