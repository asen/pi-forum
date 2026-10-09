// Plain-text formatting of forum reads, as the /forum text views show them.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  EXCERPT_CHARS,
  LIST_PAGE_SIZE,
  bodyLines,
  excerpt,
  expandTabs,
  formatMessage,
  formatMessageList,
  formatTarget,
  formatTopicList,
  printable,
  textCommand,
} from '../extension/output.js'
import { createForum } from '../src/forum.js'
import { fakeAdapter } from './fake-adapter.js'

const TARGET = { forumDir: '/forums/shared', generated: false, status: 'on', warning: null }
// Every Bidi_Control character, listed by code point as Unicode's PropList.txt names them rather than
// taken from the sanitizer: ALM, LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI and PDI.
const BIDI_CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
const BIDI = BIDI_CONTROLS.map((code) => String.fromCodePoint(code)).join('')
const BIDI_SHOWN = BIDI_CONTROLS.map((code) => `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`).join('')
const RAW_CONTROLS = new RegExp(`[\\u0000-\\u0009\\u000b-\\u001f\\u007f-\\u009f${BIDI}]`, 'u')

async function seeded({ topics = 1, messages = 0, body = (t, m) => `T${t} message ${m}` } = {}) {
  const forum = createForum({ forumDir: '/forums/shared', adapter: fakeAdapter() })
  const created = []
  for (let t = 0; t < topics; t++) {
    const { topic } = await forum.createTopic({ title: `Topic ${t}`, author: 'alice', originSessionId: 'session-a' })
    const posted = []
    for (let m = 0; m < messages; m++) posted.push(await forum.postMessage({ topicId: topic.id, author: `bob${m}`, body: body(t, m) }))
    created.push({ topic, messages: posted })
  }
  return { forum, created }
}

const lastLine = (text) => text.split('\n').at(-1)

describe('target', () => {
  test('names the directory, its origin, where it resolved and whether agents use it', () => {
    assert.equal(formatTarget(TARGET), 'Forum directory: /forums/shared (supplied PI_FORUM_DIR)\nForum is on for agents.')
    assert.equal(
      formatTarget({ forumDir: '/a/s-1', generated: true, resolved: '/real/s-1', status: 'off', warning: null }),
      'Forum directory: /a/s-1 (session default), resolved to /real/s-1\nForum is off for agents; reading does not turn it on.',
    )
    assert.equal(
      formatTarget({ forumDir: '/a', generated: false, resolved: '/a', status: 'unavailable', warning: 'PI_FORUM_DIR changed\x1b[2J' }),
      'Forum directory: /a (supplied PI_FORUM_DIR)\nWarning: the forum is unavailable (PI_FORUM_DIR changed␛[2J); reading the last selected directory.',
    )
  })
})

describe('topic lists', () => {
  test('a short first page lists every topic in full and is caught up', async () => {
    const { forum, created } = await seeded({ topics: 2 })
    const page = await forum.listTopics({ limit: LIST_PAGE_SIZE })
    const text = formatTopicList({ target: TARGET, page })
    const [a, b] = created.map(({ topic }) => topic)
    assert.equal(
      text,
      [
        'Forum topics · from the start',
        'Forum directory: /forums/shared (supplied PI_FORUM_DIR)',
        'Forum is on for agents.',
        '',
        '1. Topic 0',
        `   Topic ${a.id} · by alice · ${a.created_at}`,
        '2. Topic 1',
        `   Topic ${b.id} · by alice · ${b.created_at}`,
        '',
        'You are caught up.',
      ].join('\n'),
    )
  })

  test('a full page offers the copyable next-page command with the returned cursor', async () => {
    const { forum } = await seeded({ topics: LIST_PAGE_SIZE + 1 })
    const page = await forum.listTopics({ limit: LIST_PAGE_SIZE })
    const text = formatTopicList({ target: TARGET, page })
    assert.equal(text.match(/^\d+\. Topic \d+$/gm).length, LIST_PAGE_SIZE)
    assert.equal(lastLine(text), `20 shown; there may be more. Next page: /forum topics --after ${page.next_cursor}`)

    const after = page.next_cursor
    const rest = await forum.listTopics({ after, limit: LIST_PAGE_SIZE })
    const next = formatTopicList({ target: TARGET, page: rest, after })
    assert.match(next, new RegExp(`^Forum topics · after cursor ${after}\n`))
    assert.match(next, /\n1\. Topic 20\n/)
    assert.equal(lastLine(next), 'You are caught up.')
  })

  test('empty pages say so and are caught up; a cursor alone promises nothing', () => {
    const empty = { items: [], next_cursor: 'c1' }
    assert.match(formatTopicList({ target: TARGET, page: empty }), /\n\nNo topics yet\.\n\nYou are caught up\.$/)
    assert.match(formatTopicList({ target: TARGET, page: empty, after: 'c0' }), /\n\nNo newer topics\.\n\nYou are caught up\.$/)
    const short = { items: [{ id: 't', title: 'x', created_by: 'a', created_at: 'now' }], next_cursor: 'c2' }
    const text = formatTopicList({ target: TARGET, page: short })
    assert.doesNotMatch(text, /--after|c2|more/)
  })

  test('titles, IDs and authors are shown in full with controls made visible', () => {
    const title = `\x1b]0;pwned\x07 ${'長'.repeat(200)} **bold** ‮evil‬`
    const topic = { id: 'id‏', title, created_by: 'x\ty', created_at: '2026-01-01T00:00:00.000Z' }
    const text = formatTopicList({ target: TARGET, page: { items: [topic], next_cursor: 'c' } })
    assert.ok(text.includes(`1. ␛]0;pwned␇ ${'長'.repeat(200)} **bold** ⟨U+202E⟩evil⟨U+202C⟩`))
    assert.ok(text.includes('   Topic id⟨U+200F⟩ · by x␉y · 2026-01-01T00:00:00.000Z'))
    assert.doesNotMatch(text, RAW_CONTROLS)
  })
})

describe('message lists', () => {
  test('rows show author, timestamp, message and topic IDs, reply target and a first-line excerpt', async () => {
    const { forum, created } = await seeded({ messages: 2, body: (t, m) => (m === 0 ? 'only line' : '\n\n  # Heading\nsecond') })
    const { topic, messages } = created[0]
    const reply = await forum.postMessage({ topicId: topic.id, author: 'carol', body: 're', replyTo: messages[0].id })
    const page = await forum.listMessages({ topicId: topic.id, limit: LIST_PAGE_SIZE })
    const text = formatMessageList({ target: TARGET, topicId: topic.id, page })
    assert.equal(
      text,
      [
        `Forum messages in topic ${topic.id} · from the start`,
        'Forum directory: /forums/shared (supplied PI_FORUM_DIR)',
        'Forum is on for agents.',
        '',
        `1. bob0 · ${messages[0].created_at}`,
        `   Message ${messages[0].id} · topic ${topic.id}`,
        '   only line',
        `2. bob1 · ${messages[1].created_at}`,
        `   Message ${messages[1].id} · topic ${topic.id}`,
        '   # Heading…',
        `3. carol · ${reply.created_at}`,
        `   Message ${reply.id} · topic ${topic.id} · reply to ${messages[0].id}`,
        '   re',
        '',
        'You are caught up.',
      ].join('\n'),
    )
  })

  test('activity across topics names each topic and pages with a command without a topic', async () => {
    const { forum, created } = await seeded({ topics: 3, messages: 7 })
    const page = await forum.listMessages({ limit: LIST_PAGE_SIZE })
    const text = formatMessageList({ target: TARGET, page })
    assert.match(text, /^Forum messages across all topics · from the start\n/)
    for (const { topic } of created) assert.ok(text.includes(` · topic ${topic.id}`))
    assert.equal(lastLine(text), `20 shown; there may be more. Next page: /forum messages --after ${page.next_cursor}`)
  })

  test('a full page of one topic pages with its topic ID; untypable IDs get the cursor without a command', async () => {
    const { forum, created } = await seeded({ messages: LIST_PAGE_SIZE })
    const { topic } = created[0]
    const page = await forum.listMessages({ topicId: topic.id, limit: LIST_PAGE_SIZE })
    const text = formatMessageList({ target: TARGET, topicId: topic.id, page })
    assert.equal(lastLine(text), `20 shown; there may be more. Next page: /forum messages ${topic.id} --after ${page.next_cursor}`)
    const rest = await forum.listMessages({ topicId: topic.id, after: page.next_cursor, limit: LIST_PAGE_SIZE })
    assert.deepEqual(rest.items, [])
    assert.match(formatMessageList({ target: TARGET, topicId: topic.id, page: rest, after: page.next_cursor }), /\n\nNo newer messages\.\n\nYou are caught up\.$/)

    // A topic ID starting with "-" follows the "--" that ends the options.
    assert.equal(
      lastLine(formatMessageList({ target: TARGET, topicId: '-flag', page })),
      `20 shown; there may be more. Next page: /forum messages --after ${page.next_cursor} -- -flag`,
    )
    // IDs that cannot be typed back as one word get the cursor but no command.
    for (const topicId of ['two words', 'a\x1bb', 'a\u061cb', 'a\u00a0b']) {
      const shown = formatMessageList({ target: TARGET, topicId, page })
      assert.equal(lastLine(shown), `20 shown; there may be more after cursor ${page.next_cursor}.`)
    }
    const noCursor = formatMessageList({ target: TARGET, page: { items: page.items, next_cursor: null } })
    assert.equal(lastLine(noCursor), '20 shown; there may be more.')
  })

  test('excerpts are bounded by grapheme, never split one and show controls as visible text', () => {
    const family = '👨‍👩‍👧‍👦'
    const long = family.repeat(EXCERPT_CHARS + 5)
    const shown = excerpt(`${long}\nmore`)
    assert.equal(shown, `${family.repeat(EXCERPT_CHARS - 1)}…`)
    assert.equal(excerpt(`${'é'.repeat(EXCERPT_CHARS)}`), 'é'.repeat(EXCERPT_CHARS))
    assert.equal(excerpt(`${'é'.repeat(EXCERPT_CHARS + 1)}`), `${'é'.repeat(EXCERPT_CHARS - 1)}…`)
    assert.equal(excerpt('\t- [ ] *todo*\x1b[31m‮\n'), '- [ ] *todo*␛[31m⟨U+202E⟩')
    assert.equal(excerpt('a\r\nb\x1b'), 'a…')
  })
})

describe('message reads', () => {
  test('show all metadata and the complete body with its lines, indentation and Markdown kept', async () => {
    const { forum, created } = await seeded({ messages: 1 })
    const { topic, messages } = created[0]
    const body = '# Title\n\n```js\nif (x) {\n\treturn `y`\n}\n```\n\n  - indented *item*\n'
    const posted = await forum.postMessage({ topicId: topic.id, author: 'carol', body, originSessionId: 'session-c', replyTo: messages[0].id })
    const message = await forum.getMessage(posted.id)
    const text = formatMessage({ target: TARGET, message })
    assert.equal(
      text,
      [
        'Forum message',
        'Forum directory: /forums/shared (supplied PI_FORUM_DIR)',
        'Forum is on for agents.',
        '',
        `Message: ${posted.id}`,
        `Topic: ${topic.id}`,
        'Author: carol',
        `Created: ${posted.created_at}`,
        `Reply to: ${messages[0].id}`,
        'Origin session: session-c',
        '',
        'Body (10 lines):',
        '# Title',
        '',
        '```js',
        'if (x) {',
        '    return `y`',
        '}',
        '```',
        '',
        '  - indented *item*',
        '',
      ].join('\n'),
    )
  })

  test('omit absent reply target and origin session', () => {
    const message = { id: 'm', topic_id: 't', author: 'a', body: 'one', created_at: 'c' }
    const text = formatMessage({ target: TARGET, message })
    assert.doesNotMatch(text, /Reply to|Origin session/)
    assert.match(text, /\nBody \(1 line\):\none$/)
  })

  test('a long body is kept whole, and controls anywhere in it are made visible', () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `${' '.repeat(i % 8)}line ${i} ${'x'.repeat(i % 50)}`)
    lines[1234] = '\x1b[2J\x1b]8;;http://e\x07link\x1b]8;;\x07 ⁦iso⁩ \x9b31m del\x7f cr\r'
    const body = lines.join('\n')
    const message = { id: 'm', topic_id: 't', author: 'a\x00', body, created_at: 'c', reply_to: 'r‎', origin_session_id: 's\x85' }
    const text = formatMessage({ target: TARGET, message })
    assert.doesNotMatch(text, RAW_CONTROLS)
    assert.ok(text.includes('\nAuthor: a␀\n'))
    assert.ok(text.includes('\nReply to: r⟨U+200E⟩\n'))
    assert.ok(text.includes('\nOrigin session: s⟨U+0085⟩\n'))
    const shown = text.split('\nBody (3000 lines):\n')[1].split('\n')
    assert.equal(shown.length, 3000)
    assert.equal(shown[1234], '␛[2J␛]8;;http://e␇link␛]8;;␇ ⟨U+2066⟩iso⟨U+2069⟩ ⟨U+009B⟩31m del␡ cr␍')
    lines.forEach((line, i) => i === 1234 || assert.equal(shown[i], line))
  })

  test('tabs expand to four-column stops measured by the given width', () => {
    assert.equal(expandTabs('\tx\ty'), '    x   y')
    assert.equal(expandTabs('ab\u0007\tc'), 'ab\u0007 c')
    assert.equal(expandTabs('日本\tx'), '日本  x')
    assert.equal(expandTabs('日本\tx', (text) => [...text].reduce((n, c) => n + (c > '⺀' ? 2 : 1), 0)), '日本    x')
    const message = { id: 'm', topic_id: 't', author: 'a', body: 'a\tb', created_at: 'c' }
    assert.ok(formatMessage({ target: TARGET, message }).endsWith('\na   b'))
  })
})

describe('damaged records', () => {
  test('lists and reads count the damaged records their read skipped', () => {
    const warnings = ['skipping malformed record at byte offset 10: bad\x1b[0m', 'ignoring incomplete record at byte offset 99']
    const expected = '2 damaged record(s) skipped; first: skipping malformed record at byte offset 10: bad␛[0m'
    const page = { items: [], next_cursor: 'c' }
    assert.ok(formatTopicList({ target: TARGET, page, warnings }).includes(`\n${expected}\n`))
    assert.ok(formatMessageList({ target: TARGET, page, warnings }).includes(`\n${expected}\n`))
    const message = { id: 'm', topic_id: 't', author: 'a', body: 'b', created_at: 'c' }
    assert.ok(formatMessage({ target: TARGET, message, warnings }).includes(`\n${expected}\n`))
    assert.doesNotMatch(formatTopicList({ target: TARGET, page }), /damaged/)
  })

  test('a bounded collection keeps the first warnings and counts the rest', () => {
    const page = { items: [], next_cursor: 'c' }
    const first = '1000 damaged record(s) skipped; first: bad‮ record'
    const bounded = { items: ['bad‮ record'], omitted: 999 }
    assert.ok(formatTopicList({ target: TARGET, page, warnings: bounded }).includes(`\n${printable(first)}\n`))
    assert.ok(formatMessageList({ target: TARGET, page, warnings: { items: [], omitted: 3 } }).includes('\n3 damaged record(s) skipped\n'))
    assert.doesNotMatch(formatTopicList({ target: TARGET, page, warnings: { items: [], omitted: 0 } }), /damaged/)
  })
})

describe('bidirectional controls', () => {
  test('the list is exactly the Unicode Bidi_Control property', () => {
    const property = []
    for (let code = 0; code <= 0x10ffff; code++) if (/\p{Bidi_Control}/u.test(String.fromCodePoint(code))) property.push(code)
    assert.deepEqual(property, BIDI_CONTROLS)
  })

  test('each is shown as its code point, alone and among other text', () => {
    for (const code of BIDI_CONTROLS) {
      const char = String.fromCodePoint(code)
      const shown = `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`
      assert.equal(printable(char), shown)
      assert.equal(printable(`a${char}b`), `a${shown}b`)
    }
    assert.equal(printable(BIDI), BIDI_SHOWN)
    // Joiners and other format characters that are not bidirectional controls are left alone.
    assert.equal(printable('👩\u200d💻 a\u200cb \ufeff \u00ad'), '👩\u200d💻 a\u200cb \ufeff \u00ad')
  })

  test('every formatted field shows them, and nothing raw remains', () => {
    const topic = { id: `t${BIDI}`, title: `title ${BIDI}`, created_by: `by${BIDI}`, created_at: `at${BIDI}` }
    const message = {
      id: `m${BIDI}`,
      topic_id: `t${BIDI}`,
      author: `a${BIDI}`,
      created_at: `c${BIDI}`,
      reply_to: `r${BIDI}`,
      origin_session_id: `s${BIDI}`,
      body: `${BIDI} first\n\t${BIDI}\n**${BIDI}**`,
    }
    const target = { forumDir: `/f${BIDI}`, generated: false, resolved: `/r${BIDI}`, status: 'unavailable', warning: `w${BIDI}` }
    const page = { items: Array(LIST_PAGE_SIZE).fill(topic), next_cursor: `c${BIDI}` }
    const texts = [
      formatTarget(target),
      formatTopicList({ target, page, after: `x${BIDI}`, warnings: [`bad${BIDI}`] }),
      formatMessageList({ target, topicId: `t${BIDI}`, page: { items: [message], next_cursor: 'c' }, warnings: { items: [`bad${BIDI}`], omitted: 2 } }),
      formatMessage({ target, message, warnings: [`bad${BIDI}`] }),
      excerpt(message.body),
      ...bodyLines(message.body),
    ]
    for (const text of texts) {
      assert.doesNotMatch(text, RAW_CONTROLS)
      assert.ok(text.includes(BIDI_SHOWN), text)
    }
    assert.ok(texts[3].endsWith(`\nBody (3 lines):\n${BIDI_SHOWN} first\n    ${BIDI_SHOWN}\n**${BIDI_SHOWN}**`))
    // A cursor holding one is not offered as a command.
    assert.equal(lastLine(texts[1]), `20 shown; there may be more after cursor c${BIDI_SHOWN}.`)
  })
})

describe('text commands', () => {
  test('options come first; IDs starting with "-" follow "--"; such cursors use --after=', () => {
    const table = [
      [{ kind: 'topics' }, '/forum topics'],
      [{ kind: 'topics', after: 'c1' }, '/forum topics --after c1'],
      [{ kind: 'topics', after: '-c1' }, '/forum topics --after=-c1'],
      [{ kind: 'messages' }, '/forum messages'],
      [{ kind: 'messages', topicId: 't-1' }, '/forum messages t-1'],
      [{ kind: 'messages', topicId: 't-1', after: 'c1' }, '/forum messages t-1 --after c1'],
      [{ kind: 'messages', after: 'c1' }, '/forum messages --after c1'],
      [{ kind: 'messages', topicId: '-odd' }, '/forum messages -- -odd'],
      [{ kind: 'messages', topicId: '--after=x', after: 'c1' }, '/forum messages --after c1 -- --after=x'],
      [{ kind: 'messages', topicId: '--', after: '-c1' }, '/forum messages --after=-c1 -- --'],
      [{ kind: 'messages', topicId: 'on' }, '/forum messages on'],
      [{ kind: 'read', messageId: 'm-1' }, '/forum read m-1'],
      [{ kind: 'read', messageId: '--after=x' }, '/forum read -- --after=x'],
      [{ kind: 'read', messageId: '--' }, '/forum read -- --'],
      [{ kind: 'read', messageId: 'ui' }, '/forum read ui'],
    ]
    for (const [view, command] of table) assert.equal(textCommand(view), command, JSON.stringify(view))
  })

  test('arguments that cannot be typed back as one word give no command', () => {
    for (const bad of ['', 'two words', 'tab\there', 'line\nbreak', 'esc\x1b', 'del\x7f', 'c1\x85', 'nbsp\u00a0x', ...[...BIDI].map((c) => `x${c}`)]) {
      assert.equal(textCommand({ kind: 'read', messageId: bad }), null, JSON.stringify(bad))
      assert.equal(textCommand({ kind: 'messages', topicId: bad }), null, JSON.stringify(bad))
      assert.equal(textCommand({ kind: 'topics', after: bad }), null, JSON.stringify(bad))
    }
  })
})

test('printable is shared with the terminal browser', async () => {
  const browser = await import('../extension/browser.js')
  assert.equal(browser.printable, printable)
})
