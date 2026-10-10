// Forum text for people: the sanitizing helpers the terminal browser shares, and plain-text
// formatters for the results of src/forum.mjs reads (a listTopics or listMessages page, or one
// getMessage record). Forum text is peer data: control characters and bidirectional formatting are
// shown as visible symbols, Markdown stays literal, and nothing is styled, so the text means the same
// wherever it is shown and no terminal escape is ever interpreted.
//
// The formatters take what the caller read and never read more. A target is the browsed directory as
// the runtime describes it: { forumDir, generated, project?, resolved?, status, warning? }. Warnings are the
// messages the read reported through onWarning, one per damaged record skipped: an array, or
// { items, omitted } when the caller kept only the first items and counted the rest. The requests
// and views are typed in types.ts.

import type { Message, Page, Topic } from '../src/types.d.mts'
import type {
  ForumBinding,
  ForumTarget,
  ForumView,
  ListView,
  MessageListRequest,
  MessageRequest,
  ReadWarnings,
  TopicListRequest,
  VisibleWidth,
  WarningSummary,
} from './types.ts'

// Rows per text list page; the caller reads each page with this limit.
export const LIST_PAGE_SIZE = 20
// Graphemes of a body's first line shown in a message list row.
export const EXCERPT_CHARS = 80
const TAB_STOP = 4

// Shows control characters as visible text: C0 controls as control pictures (U+2400...), DEL as ␡,
// and C1 controls and every Bidi_Control character (the marks, embeddings, overrides and isolates,
// including U+061C ARABIC LETTER MARK) as ⟨U+XXXX⟩.
export function printable(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\p{Bidi_Control}]/gu, (char) => {
    // Every match is one code point.
    const code = char.codePointAt(0)!
    if (code < 0x20) return String.fromCharCode(0x2400 + code)
    if (code === 0x7f) return '␡'
    return `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`
  })
}

const segmenter = new Intl.Segmenter()
const graphemes = (text: string): string[] => [...segmenter.segment(text)].map((s) => s.segment)

// Expands tabs to the next TAB_STOP column so indentation keeps its shape. Columns are measured on
// the printable text with visibleWidth, by default one per grapheme.
export function expandTabs(text: string, visibleWidth: VisibleWidth = (shown) => graphemes(shown).length): string {
  if (!text.includes('\t')) return text
  let out = ''
  let column = 0
  for (const part of text.split('\t').map((piece, i) => (i === 0 ? piece : ['\t', piece])).flat()) {
    const shown = part === '\t' ? ' '.repeat(TAB_STOP - (column % TAB_STOP)) : part
    out += shown
    column += visibleWidth(printable(shown))
  }
  return out
}

// A body as printable lines: its line breaks, indentation and Markdown kept as written.
export function bodyLines(body: string, visibleWidth?: VisibleWidth): string[] {
  return body.split('\n').map((line) => printable(expandTabs(line, visibleWidth)))
}

// The body's first nonblank line on one row, cut to EXCERPT_CHARS graphemes; … marks anything left out.
export function excerpt(body: string): string {
  const lines = body.split('\n')
  const index = Math.max(0, lines.findIndex((line) => line.trim() !== ''))
  // split always returns at least one line, and index is one of them.
  const all = graphemes(lines[index]!.replaceAll('\t', ' ').trim())
  const cut = all.length > EXCERPT_CHARS
  const more = cut || lines.slice(index + 1).some((line) => line.trim() !== '')
  return printable(all.slice(0, cut ? EXCERPT_CHARS - 1 : all.length).join('') + (more ? '…' : ''))
}

// Directory origin is independent of environment ownership: both defaults are generated bindings.
export function bindingOrigin({ generated, project }: Pick<ForumBinding, 'generated' | 'project'>): string {
  return project ? 'project default' : generated ? 'session default' : 'supplied PI_FORUM_DIR'
}

// The browsed directory, where it resolved once known, and whether agents use it.
export function formatTarget({ forumDir, generated, project, resolved, status, warning }: ForumTarget): string {
  const origin = bindingOrigin({ generated, project })
  const real = resolved && resolved !== forumDir ? `, resolved to ${resolved}` : ''
  const lines = [`Forum directory: ${forumDir} (${origin})${real}`]
  if (warning) lines.push(`Warning: the forum is unavailable (${warning}); reading the last selected directory.`)
  else lines.push(status === 'on' ? 'Forum is on for agents.' : 'Forum is off for agents; reading does not turn it on.')
  return lines.map(printable).join('\n')
}

// One page of listTopics: page is its { items, next_cursor }, after the cursor it was read after.
export function formatTopicList({ target, page, after, warnings = [] }: TopicListRequest): string {
  const lines = [heading('Forum topics', after), formatTarget(target), '']
  if (page.items.length === 0) lines.push(after ? 'No newer topics.' : 'No topics yet.')
  page.items.forEach((topic, i) => {
    lines.push(printable(`${i + 1}. ${topic.title}`))
    lines.push(printable(`   Topic ${topic.id} · by ${topic.created_by} · ${topic.created_at}`))
  })
  lines.push(...damaged(warnings), '', paging(page, { kind: 'topics' }))
  return lines.join('\n')
}

// One page of listMessages; topicId is the topic it listed, or undefined for activity across the forum.
export function formatMessageList({ target, topicId, page, after, warnings = [] }: MessageListRequest): string {
  const name = topicId === undefined ? 'Forum messages across all topics' : `Forum messages in topic ${topicId}`
  const lines = [heading(name, after), formatTarget(target), '']
  if (page.items.length === 0) lines.push(after ? 'No newer messages.' : 'No messages yet.')
  page.items.forEach((message, i) => {
    const reply = message.reply_to ? ` · reply to ${message.reply_to}` : ''
    lines.push(printable(`${i + 1}. ${message.author} · ${message.created_at}`))
    lines.push(printable(`   Message ${message.id} · topic ${message.topic_id}${reply}`))
    lines.push(`   ${excerpt(message.body)}`)
  })
  lines.push(...damaged(warnings), '', paging(page, { kind: 'messages', topicId }))
  return lines.join('\n')
}

// One getMessage record: all of its metadata, then the complete body.
export function formatMessage({ target, message, warnings = [], visibleWidth }: MessageRequest): string {
  const lines = ['Forum message', formatTarget(target), '']
  lines.push(printable(`Message: ${message.id}`))
  lines.push(printable(`Topic: ${message.topic_id}`))
  lines.push(printable(`Author: ${message.author}`))
  lines.push(printable(`Created: ${message.created_at}`))
  if (message.reply_to) lines.push(printable(`Reply to: ${message.reply_to}`))
  if (message.origin_session_id) lines.push(printable(`Origin session: ${message.origin_session_id}`))
  lines.push(...damaged(warnings))
  const body = bodyLines(message.body, visibleWidth)
  lines.push('', `Body (${body.length} line${body.length === 1 ? '' : 's'}):`, ...body)
  return lines.join('\n')
}

function heading(name: string, after: string | undefined): string {
  return printable(`${name} · ${after ? `after cursor ${after}` : 'from the start'}`)
}

// Array.isArray, which does not narrow a readonly array out of a union.
const isWarningList = (warnings: ReadWarnings): warnings is readonly string[] => Array.isArray(warnings)

function damaged(warnings: ReadWarnings): string[] {
  const { items, omitted = 0 }: WarningSummary = isWarningList(warnings) ? { items: warnings } : warnings
  const count = items.length + omitted
  if (count === 0) return []
  return [printable(`${count} damaged record(s) skipped${items.length ? `; first: ${items[0]}` : ''}`)]
}

// A full page may have more after it; only its returned cursor continues. A shorter page is the end.
function paging(page: Page<Topic> | Page<Message>, view: ListView): string {
  const count = page.items.length
  if (count < LIST_PAGE_SIZE) return 'You are caught up.'
  const cursor = page.next_cursor
  const command = cursor && textCommand({ ...view, after: cursor })
  if (command) return `${count} shown; there may be more. Next page: ${command}`
  return printable(`${count} shown; there may be more${cursor ? ` after cursor ${cursor}` : ''}.`)
}

// The /forum command that reads view ({ kind: 'topics' | 'messages' | 'read', topicId?, messageId?,
// after? }) as text, or null when an argument would not survive being typed back as one word: empty,
// with whitespace, or with characters printable() would replace. Options come first; an ID starting
// with "-" follows a "--" that ends them, and a cursor starting with "-" is written --after=CURSOR.
export function textCommand({ kind, topicId, messageId, after }: ForumView): string | null {
  const id = kind === 'messages' ? topicId : kind === 'read' ? messageId : undefined
  const args = [id, after].filter((arg) => arg !== undefined)
  if (!args.every((arg) => arg !== '' && /^\S+$/.test(arg) && printable(arg) === arg)) return null
  const words: string[] = [kind]
  const options = after === undefined ? [] : after.startsWith('-') ? [`--after=${after}`] : ['--after', after]
  if (id === undefined) words.push(...options)
  else if (id.startsWith('-')) words.push(...options, '--', id)
  else words.push(id, ...options)
  return `/forum ${words.join(' ')}`
}
