// The terminal browser overlay, headless. Each test runs against a small stand-in for Pi's terminal
// helpers, and also against the real @earendil-works/pi-tui when PI_FORUM_TEST_PI_ROOT names an
// installed Pi. The host's ctx.ui.custom is replaced by one that follows its documented contract.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CustomEntry, EntryRenderOptions, ExtensionContext, ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { type BrowserHost, type BrowserTheme, type BrowserTui, createBrowserOpener, overlayHeight, printable } from '../extension/browser.ts'
import { type Browser, type BrowserForum, type BrowserState, createBrowser } from '../extension/browser-state.ts'
import { createEntryRenderer, ENTRY_TYPE, type EntryRendererTui } from '../extension/entry-renderer.ts'
import { createForumRuntime } from '../extension/runtime.ts'
import type { ForumTarget, ForumView, RuntimeContext } from '../extension/types.ts'
import { createForum } from '../src/forum.mjs'
import type { ListOptions, Message, Page, Topic } from '../src/types.d.mts'
import { fakeAdapter } from './fake-adapter.ts'
import { hostLibrary } from './pi-fixtures.ts'

const PI_ROOT = process.env.PI_FORUM_TEST_PI_ROOT
// Every Bidi_Control character, by code point: ALM, LRM, RLM, LRE, RLE, PDF, LRO, RLO, LRI, RLI, FSI, PDI.
const BIDI_CONTROLS = [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]
const BIDI = BIDI_CONTROLS.map((code) => String.fromCodePoint(code)).join('')
const BIDI_SHOWN = BIDI_CONTROLS.map((code) => `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`).join('')
const RAW = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${BIDI}]`, 'u')
const settle = () => new Promise(setImmediate)

// Waits until the browser's current load has settled; the fake adapter yields between records.
async function idle(browser: Browser) {
  for (let i = 0; i < 10000 && browser.state.status === 'loading' && !browser.closed; i++) await settle()
}

// Enough of pi-tui for headless tests: grapheme widths with wide East Asian characters and emoji,
// ANSI-aware widths, hard wrapping and the keys the browser uses.
const ANSI = /\x1b\[[0-9;]*m/g
const segmenter = new Intl.Segmenter()
const graphemeWidth = (g: string) =>
  /^\p{Extended_Pictographic}/u.test(g) || /^[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(g)
    ? 2
    : /^\p{M}/u.test(g)
      ? 0
      : 1
const graphemes = (text: string) => [...segmenter.segment(text.replace(ANSI, ''))].map((s) => s.segment)
const KEYS = {
  escape: ['\x1b'],
  enter: ['\r'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
  right: ['\x1b[C'],
  left: ['\x1b[D'],
  pageUp: ['\x1b[5~'],
  pageDown: ['\x1b[6~'],
  home: ['\x1b[H'],
  end: ['\x1b[F'],
  backspace: ['\x7f'],
}
// The same table, looked up by any of Pi's key IDs.
const keyData: { readonly [id: string]: readonly string[] | undefined } = KEYS

// A terminal library the overlay runs on: the Pi terminal helpers it uses, named for its suite.
type Library = BrowserTui & { readonly name: string }

const standIn: Library = {
  name: 'stand-in',
  visibleWidth: (text) => graphemes(text).reduce((sum, g) => sum + graphemeWidth(g), 0),
  matchesKey: (data, id) => (keyData[id] ?? [id]).includes(data),
  truncateToWidth(text, width, ellipsis = '…', pad = false) {
    let out = ''
    let used = 0
    const all = graphemes(text)
    const total = all.reduce((sum, g) => sum + graphemeWidth(g), 0)
    const room = total > width ? width - 1 : width
    for (const g of all) {
      if (used + graphemeWidth(g) > room) break
      out += g
      used += graphemeWidth(g)
    }
    if (total > width && width > 0) {
      out += ellipsis
      used += 1
    }
    return pad ? out + ' '.repeat(Math.max(0, width - used)) : out
  },
  wrapTextWithAnsi(text, width) {
    const lines = ['']
    let used = 0
    for (const g of graphemes(text)) {
      if (used + graphemeWidth(g) > width && used > 0) {
        lines.push('')
        used = 0
      }
      lines[lines.length - 1] += g
      used += graphemeWidth(g)
    }
    return lines
  },
}

// The installed Pi's pi-tui also provides the Text the entry renderer uses.
const libraries: (Library & Partial<EntryRendererTui>)[] = [standIn]
if (PI_ROOT) {
  // Typed as the pi-tui this repository develops against.
  const tui: typeof import('@earendil-works/pi-tui') = await import(hostLibrary(PI_ROOT, 'pi-tui'))
  libraries.push({ name: 'pi-tui', ...tui })
}

// The styles the overlay uses, and the code they are drawn with.
type TestTheme = BrowserTheme & { code: number }

// A theme whose styles are ANSI sequences, swappable to check that nothing themed is cached.
function testTheme(): TestTheme {
  const theme: TestTheme = {
    code: 3,
    fg: (token, text) => `\x1b[${theme.code}${token.length % 8}m${text}\x1b[39m`,
    bg: (token, text) => `\x1b[4${token.length % 8}m${text}\x1b[49m`,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
  }
  return theme
}

// The overlay component the host shows: the forum browser view, which takes input and is disposed,
// with the browser it draws.
type Overlay = Component & { handleInput(data: string): void; dispose(): void; readonly browser: Browser }

// The part of Pi's TUI the stand-in host gives: what the overlay uses, and a terminal size that tests
// change.
type HostTui = BrowserHost & { terminal: { rows: number; columns: number } }

// ctx.ui.custom's factory as the stand-in host calls it: with its TUI, its theme and no keybindings,
// none of which is Pi's whole TUI, Theme or KeybindingsManager.
type HostFactory = (tui: HostTui, theme: BrowserTheme, keybindings: object, done: (result: never) => void) => Overlay | Promise<Overlay>

interface PiHost {
  renders: number
  focus: 'editor' | 'overlay'
  disposals: number
  component: Overlay | null
  options: Parameters<ExtensionUIContext['custom']>[1] | null
  theme: TestTheme
  tui: HostTui
  ctx: RuntimeContext & Pick<ExtensionContext, 'abort'>
  lines(): string[]
  text(): string
  press(...keys: string[]): Promise<void>
}

// ctx.ui.custom as Pi documents it: the factory gets (tui, theme, keybindings, done); done resolves
// the promise once, removes the overlay, restores the editor's focus and disposes the component.
function piHost({ rows = 30, columns = 100 } = {}) {
  const host: PiHost = {
    renders: 0,
    focus: 'editor',
    disposals: 0,
    component: null,
    options: null,
    theme: testTheme(),
    tui: {
      terminal: { rows, columns },
      requestRender: () => host.renders++,
    },
    // @ts-expect-error -- no cwd, so the runtime reads no project defaults, and no session manager,
    // which it reads only to derive a directory where these tests supply PI_FORUM_DIR
    ctx: {
      mode: 'tui',
      hasUI: true,
      abort: () => assert.fail('the browser never aborts the agent'),
      ui: {
        notify: () => {},
        custom(factory, options) {
          host.options = options
          // The only factory here is the browser opener's, which uses no more than the stand-ins give.
          const create = factory as HostFactory
          return new Promise((resolve) => {
            let closed = false
            const done = (result: Parameters<Parameters<typeof factory>[3]>[0]) => {
              if (closed) return
              closed = true
              host.focus = 'editor'
              resolve(result)
              host.disposals++
              host.component?.dispose?.()
            }
            Promise.resolve(create(host.tui, host.theme, {}, done)).then((component) => {
              if (closed) return
              host.component = component
              host.focus = 'overlay'
            })
          })
        },
      },
    },
    // What the overlay shows at the terminal's current size.
    lines: () => host.component!.render(Math.floor((host.tui.terminal.columns * 90) / 100)),
    text: () => host.lines().map((line) => line.replace(ANSI, '').trimEnd()).join('\n'),
    press: async (...keys) => {
      for (const key of keys) {
        host.component!.handleInput(key)
        await settle()
        await idle(host.component!.browser)
      }
    },
  }
  return host
}

async function seededForum({
  topics = 3,
  messages = 3,
  body = (t: number, m: number) => `T${t} message ${m}\nsecond line`,
}: { topics?: number; messages?: number; body?: (t: number, m: number) => string } = {}) {
  const forum = createForum({ forumDir: '/forums/shared', adapter: fakeAdapter() })
  const created: { topic: Topic; messages: Message[] }[] = []
  for (let t = 0; t < topics; t++) {
    const { topic } = await forum.createTopic({ title: `Topic ${t}`, author: 'alice' })
    const posted: Message[] = []
    for (let m = 0; m < messages; m++) posted.push(await forum.postMessage({ topicId: topic.id, author: `bob${m}`, body: body(t, m) }))
    created.push({ topic, messages: posted })
  }
  return { forum, created }
}

const TARGET: ForumTarget = { forumDir: '/forums/shared', generated: false, status: 'on', warning: null }

// Opens a browser on forum in a fresh Pi host; resolves once its first load has rendered.
async function open(
  lib: Library,
  forum: BrowserForum,
  view: ForumView = { kind: 'topics' },
  { host = piHost(), pageSize, target = TARGET }: { host?: PiHost; pageSize?: number; target?: ForumTarget } = {},
) {
  const browser = createBrowser({ forum, target, view, pageSize })
  // The opener takes the runtime's whole request and reads only its browser and ctx.
  const request = { browser, ctx: host.ctx, target, view }
  const closed = createBrowserOpener(lib)(request)
  await settle()
  await idle(browser)
  return { host, browser, closed }
}

// Object.fromEntries keeps no key names, so they are restored here.
const KEY = Object.fromEntries(Object.entries(KEYS).map(([id, [data]]) => [id, data])) as { readonly [id in keyof typeof KEYS]: string }

// Every rendered line fits the width, the height fits the overlay, and forum text carries no raw
// control characters once the theme's own styling is removed.
function assertFits(lib: Library, host: PiHost, width: number) {
  const lines = host.component!.render(width)
  assert.ok(lines.length <= overlayHeight(host.tui), `${lines.length} lines for ${host.tui.terminal.rows} rows`)
  for (const line of lines) {
    assert.ok(lib.visibleWidth(line) <= width, `${JSON.stringify(line)} is wider than ${width}`)
    assert.doesNotMatch(line.replace(ANSI, ''), RAW, JSON.stringify(line))
  }
  return lines
}

for (const lib of libraries) {
  describe(`terminal browser (${lib.name})`, { timeout: 20000 }, () => {
    test('topics open their messages, Enter opens the complete message, Back restores each selection', async () => {
      const { forum, created } = await seededForum()
      const { host, browser, closed } = await open(lib, forum)
      assert.equal(host.focus, 'overlay')
      assert.deepEqual(host.options, { overlay: true, overlayOptions: { anchor: 'center', width: '90%', maxHeight: '80%' } })
      let text = host.text()
      assert.match(text, /^Forum · Topics · page 1\nDirectory: \/forums\/shared\nForum is on for agents\n› Topic 0 · alice/)
      assert.match(text, /↑↓ select · Enter open · r refresh · b\/Esc close$/)

      await host.press(KEY.down, KEY.down, KEY.enter)
      assert.deepEqual(browser.state.view, { kind: 'messages', topicId: created[2]!.topic.id, topic: created[2]!.topic })
      text = host.text()
      assert.match(text, /^Forum · Messages in "Topic 2" · page 1/)
      assert.match(text, /› bob0 · \d{4}-\d\d-\d\d \d\d:\d\d · T2 message 0/)
      assert.doesNotMatch(text, /second line/)

      await host.press(KEY.down, KEY.enter)
      const chosen = created[2]!.messages[1]!
      assert.deepEqual(browser.state.message, chosen)
      text = host.text()
      assert.match(text, new RegExp(`^Forum · Message ${chosen.id}\\n`))
      assert.match(text, /From bob1 · .*\nTopic .*\nT2 message 1\nsecond line\n/)
      assert.match(text, /1-2\/2 · ↑↓ PgUp PgDn Home End scroll · r refresh · b back · Esc close$/)

      await host.press('b')
      // Fresh snapshots of the list views, not the message view's narrowed above.
      assert.equal((browser.state as BrowserState).page!.selection, 1)
      await host.press(KEY.backspace)
      assert.equal((browser.state as BrowserState).page!.selection, 2)
      assert.match(host.text(), /› Topic 2/)
      await host.press('b')
      assert.equal(await closed, undefined)
      assert.equal(browser.closeReason, 'back')
      assert.equal(host.focus, 'editor')
      assert.equal(host.disposals, 1)
    })

    test('activity across topics names each message’s topic', async () => {
      const { forum, created } = await seededForum({ topics: 2, messages: 1 })
      const { host, browser } = await open(lib, forum, { kind: 'messages' })
      const text = host.text()
      assert.match(text, /^Forum · All activity · page 1/)
      for (const { topic } of created) assert.match(text, new RegExp(`topic ${topic.id.slice(0, 8)} · T`))
      browser.close()
    })

    test('paging, refresh and actions follow the controller, and invalid keys do nothing', async () => {
      const { forum, created } = await seededForum({ topics: 5, messages: 0 })
      const { host, browser } = await open(lib, forum, { kind: 'topics' }, { pageSize: 2 })
      assert.match(host.text(), /Enter open · → next · r refresh · b\/Esc close$/)
      await host.press(KEY.left)
      assert.equal(browser.state.page!.index, 0)
      await host.press(KEY.right)
      assert.match(host.text(), /^Forum · Topics · page 2/)
      assert.match(host.text(), /← prev · → next/)
      await host.press('n')
      assert.equal(browser.state.page!.index, 2)
      assert.deepEqual(browser.state.page!.items, [created[4]!.topic])
      assert.doesNotMatch(host.text(), /→ next/)
      await host.press(KEY.right, 'n')
      assert.equal(browser.state.page!.index, 2)
      await host.press('p')
      assert.equal(browser.state.page!.index, 1)

      // Refresh rereads the page and shows appended records on a short last page.
      await host.press('n')
      const { topic } = await forum.createTopic({ title: 'Fresh', author: 'zed' })
      await host.press('r')
      assert.deepEqual(browser.state.page!.items, [created[4]!.topic, topic])
      assert.match(host.text(), /Fresh · zed/)
      browser.close()
    })

    test('an empty caught-up page says so and refreshes into new activity', async () => {
      const { forum, created } = await seededForum({ topics: 1, messages: 2 })
      const topicId = created[0]!.topic.id
      const { host, browser } = await open(lib, forum, { kind: 'messages', topicId }, { pageSize: 2 })
      assert.match(host.text(), new RegExp(`^Forum · Messages in topic ${topicId} · page 1`))
      await host.press(KEY.right)
      assert.match(host.text(), /No messages yet\. You are caught up; r refreshes\./)
      await forum.postMessage({ topicId, author: 'carol', body: 'news' })
      await host.press('r')
      assert.match(host.text(), /› carol · .* · news/)
      browser.close()
    })

    test('errors show their code, message and directory with only the valid actions', async () => {
      const { forum } = await seededForum({ topics: 3, messages: 0 })
      let invalid = false
      const client: Pick<BrowserForum, 'listTopics'> = {
        listTopics: (options: ListOptions) =>
          invalid && options.after !== undefined
            ? Promise.reject(Object.assign(new Error('cursor belongs to a different forum'), { code: 'INVALID_CURSOR' }))
            : forum.listTopics(options),
      }
      // @ts-expect-error -- a client with only the read this test makes
      const { host, browser } = await open(lib, client, { kind: 'topics' }, { pageSize: 2 })
      await host.press(KEY.right)
      invalid = true
      await host.press('r')
      let text = host.text()
      assert.match(text, /INVALID_CURSOR: cursor belongs to a different forum\nForum directory: \/forums\/shared/)
      assert.match(text, /s restart · b\/Esc close$/)
      assert.doesNotMatch(text, /r retry/)
      // r does not retry an invalid cursor, and nothing resets until Restart.
      await host.press('r', KEY.enter, KEY.right)
      assert.equal(browser.state.status, 'error')
      assert.equal(browser.state.page!.index, 1)
      await host.press('s')
      assert.equal(browser.state.page!.index, 0)
      assert.equal(browser.state.status, 'ready')

      const missing = await open(lib, forum, { kind: 'read', messageId: 'nope' })
      text = missing.host.text()
      assert.match(text, /NOT_FOUND: message nope not found/)
      assert.match(text, /r retry · b\/Esc close$/)
      await missing.host.press('r')
      assert.equal(missing.browser.state.error!.code, 'NOT_FOUND')
      await missing.host.press(KEY.escape)
      assert.equal(await missing.closed, undefined)
      browser.close()
    })

    test('the reader reaches the last line of a 64 KiB body with arrows, pages, Home and End', async () => {
      const lines = Array.from({ length: 1500 }, (_, i) => `line ${String(i).padStart(4, '0')} ${'·'.repeat(12)}`)
      let body = lines.join('\n')
      body = `${body}${'x'.repeat(64 * 1024 - Buffer.byteLength(body) - Buffer.byteLength('\nLAST LINE ✓'))}\nLAST LINE ✓`
      assert.equal(Buffer.byteLength(body), 64 * 1024)
      const { forum } = await seededForum({ topics: 1, messages: 1, body: () => body })
      const host = piHost({ rows: 20, columns: 60 })
      const { browser } = await open(lib, forum, { kind: 'messages' }, { host })
      await host.press(KEY.enter)
      assert.equal(browser.state.message!.body, body)
      let text = host.text()
      assert.match(text, /\nline 0000 /)
      assert.match(text, / ↓ · ↑↓ PgUp PgDn Home End scroll/)
      await host.press(KEY.down, KEY.down)
      assert.match(host.text(), /\nline 0002 /)
      await host.press(KEY.pageDown)
      assert.doesNotMatch(host.text(), /\nline 0002 /)
      await host.press(KEY.end)
      text = host.text()
      assert.match(text, /LAST LINE ✓\n[^\n]* ↑ · ↑↓/)
      const [, last, total] = text.match(/(\d+)-(\d+)\/(\d+) ↑/)!.slice(1)
      assert.equal(last, total)
      for (let i = 0; i < 5; i++) await host.press(KEY.pageDown, KEY.down)
      assert.match(host.text(), /LAST LINE ✓/)
      await host.press(KEY.home)
      assert.match(host.text(), /\nline 0000 /)
      // Narrowing the terminal rewraps and keeps the end reachable.
      host.tui.terminal.columns = 25
      host.tui.terminal.rows = 9
      await host.press(KEY.end)
      assert.match(host.text(), /LAST LINE ✓/)
      assertFits(lib, host, 22)
      browser.close()
    })

    test('lines fit every width and height, with wide, combining, emoji and control content shown as text', async () => {
      const awkward = '\x1b[31mred\x1b[0m 日本語 👩‍💻 e\u0301 \u202eevil\u202c \x9b2J tab\there \r\nend'
      const { forum } = await seededForum({ topics: 2, messages: 2, body: () => awkward })
      await forum.createTopic({ title: `\x1b]0;title\x07 ${'長'.repeat(60)} 🧵`, author: 'x\ty' })
      const host = piHost()
      const { browser } = await open(lib, forum, { kind: 'messages' }, { host, target: { ...TARGET, forumDir: '/forums/\x1b[2Jdir' } })
      for (const rows of [1, 2, 3, 4, 8, 40]) {
        host.tui.terminal.rows = rows
        for (const width of [1, 2, 5, 11, 40, 200]) assertFits(lib, host, width)
      }
      host.tui.terminal.rows = 30
      await host.press(KEY.enter)
      for (const width of [1, 3, 9, 30, 120]) assertFits(lib, host, width)
      const shown = host.text()
      assert.match(shown, /␛\[31mred␛\[0m 日本語 👩‍💻 e\u0301 ⟨U\+202E⟩evil⟨U\+202C⟩ ⟨U\+009B⟩2J tab +here ␍\nend/)
      assert.match(shown, /Directory: \/forums\/␛\[2Jdir/)
      // The stored body is untouched.
      assert.equal(browser.state.message!.body, awkward)
      browser.close()
    })

    test('every bidirectional control is shown as its code point in lists, headers and the reader', async () => {
      const { forum } = await seededForum({ topics: 0 })
      const { topic } = await forum.createTopic({ title: `title ${BIDI}`, author: `by ${BIDI}` })
      await forum.postMessage({ topicId: topic.id, author: `from ${BIDI}`, body: `first ${BIDI}\n\t${BIDI} indented` })
      const host = piHost({ columns: 400 })
      const target: ForumTarget = { ...TARGET, forumDir: `/forums/${BIDI}`, status: 'unavailable', warning: `drift ${BIDI}` }
      const { browser } = await open(lib, forum, { kind: 'topics' }, { host, target })
      assertFits(lib, host, 360)
      let shown = host.text()
      assert.ok(shown.includes(`title ${BIDI_SHOWN} · by ${BIDI_SHOWN}`), shown)
      assert.ok(shown.includes(`Directory: /forums/${BIDI_SHOWN}`), shown)
      assert.ok(shown.includes(`Unavailable: drift ${BIDI_SHOWN}`), shown)
      await host.press(KEY.enter)
      assertFits(lib, host, 360)
      assert.ok(host.text().includes(`from ${BIDI_SHOWN} · `), host.text())
      await host.press(KEY.enter)
      assertFits(lib, host, 360)
      shown = host.text()
      assert.ok(shown.includes(`From from ${BIDI_SHOWN} · `), shown)
      assert.ok(shown.includes(`\nfirst ${BIDI_SHOWN}\n    ${BIDI_SHOWN} indented`), shown)
      browser.close()
    })

    test('theme changes and invalidation restyle without stale colors', async () => {
      const { forum } = await seededForum({ topics: 1, messages: 1 })
      const { host, browser } = await open(lib, forum)
      const before = host.lines()
      host.theme.code = 9
      host.component!.invalidate()
      const after = host.lines()
      assert.deepEqual(after.map((line) => line.replace(ANSI, '')), before.map((line) => line.replace(ANSI, '')))
      assert.ok(after.some((line) => line.includes('\x1b[9')))
      assert.ok(!after.some((line) => /\x1b\[3[0-8]m/.test(line)))
      browser.close()
    })

    test('Esc while loading closes only the viewer, aborts its read and renders nothing later', async () => {
      const calls: { options: ListOptions; resolve: (page: Page<Topic>) => void }[] = []
      const pending: Pick<BrowserForum, 'listTopics'> = {
        listTopics: (options: ListOptions) => new Promise((resolve) => calls.push({ options, resolve })),
      }
      // @ts-expect-error -- a client with only the read this test makes
      const { host, browser, closed } = await open(lib, pending)
      assert.match(host.text(), /^Forum · Topics · page 1 · loading…\n.*\n.*\nLoading…/)
      host.component!.handleInput(KEY.escape)
      assert.equal(await closed, undefined)
      assert.equal(browser.closeReason, 'closed')
      assert.equal(calls[0]!.options.signal!.aborted, true)
      assert.equal(host.focus, 'editor')
      const renders = host.renders
      calls[0]!.resolve({ items: [{ id: 't', title: 'late', created_by: 'a', created_at: 'z' }], next_cursor: 'c' })
      await settle()
      assert.equal(host.renders, renders)
      // Repeated input, done and dispose are harmless.
      host.component!.handleInput(KEY.escape)
      host.component!.dispose()
      assert.equal(host.disposals, 1)
    })

    test('a discarded selection or shutdown ends the interaction through done, without late renders', async () => {
      // Settled only with empty pages, which suit either read.
      const calls: { options: ListOptions; resolve: (page: Page<never>) => void }[] = []
      const client: Pick<BrowserForum, 'resolved' | 'listTopics' | 'listMessages'> = {
        resolved: undefined,
        listTopics: (options: ListOptions) => new Promise((resolve) => calls.push({ options, resolve })),
        listMessages: (options: ListOptions) => new Promise((resolve) => calls.push({ options, resolve })),
      }
      for (const end of ['shutdown', 'reselect']) {
        const host = piHost()
        const env = { PATH: '/usr/bin', PI_FORUM_DIR: '/forums/shared' }
        const reports: string[] = []
        const runtime = createForumRuntime({
          binDir: '/pkg/bin',
          getAgentDir: () => '/agent',
          env,
          report: (message) => reports.push(message),
          mkdir: () => {},
          // @ts-expect-error -- a client with only the reads these browsers make
          createForum: () => client,
          openBrowser: createBrowserOpener(lib),
        })
        // @ts-expect-error -- a session start with only the session ID; PI_FORUM_DIR selects the forum
        runtime.sessionStart({ sessionManager: { getSessionId: () => 's-1' } })
        const browsing = runtime.command(end === 'shutdown' ? 'ui' : 'ui topics', host.ctx)
        await settle()
        assert.equal(host.focus, 'overlay')
        const read = calls.at(-1)!
        if (end === 'shutdown') runtime.sessionShutdown()
        else {
          env.PI_FORUM_DIR = '/forums/other'
          runtime.command('on', host.ctx)
        }
        assert.equal(await browsing, undefined)
        assert.equal(host.focus, 'editor')
        assert.equal(host.disposals, 1)
        assert.equal(read.options.signal!.aborted, true)
        const renders = host.renders
        read.resolve({ items: [], next_cursor: 'c' })
        await settle()
        assert.equal(host.renders, renders)
        assert.deepEqual(reports, end === 'shutdown' ? [] : ['Forum is on: /forums/other (supplied PI_FORUM_DIR)'])
        runtime.sessionShutdown()
      }
    })

    test('modes other than the terminal UI never open the overlay', async () => {
      const runtime = createForumRuntime({
        binDir: '/pkg/bin',
        getAgentDir: () => '/agent',
        env: { PATH: '/usr/bin', PI_FORUM_DIR: '/forums/shared' },
        report: () => {},
        mkdir: () => {},
        createForum: () => assert.fail('text modes bind no client'),
        openBrowser: createBrowserOpener(lib),
      })
      // @ts-expect-error -- a session start with only the session ID; PI_FORUM_DIR selects the forum
      runtime.sessionStart({ sessionManager: { getSessionId: () => 's-1' } })
      const ui = { notify: () => {}, custom: () => assert.fail('only the terminal UI has custom components') }
      for (const mode of ['rpc', 'json', 'print'] as const) {
        // @ts-expect-error -- no cwd, so the runtime reads no project defaults
        await runtime.command('ui topics', { mode, hasUI: mode === 'rpc', ui, sessionManager: { getSessionId: () => 's-1' } })
      }
      runtime.sessionShutdown()
    })

    test('text reads run beside the open overlay, on the same client, and never draw in it', async () => {
      const { forum, created } = await seededForum({ topics: 2, messages: 1 })
      const host = piHost()
      const texts: string[] = []
      const reports: string[] = []
      const runtime = createForumRuntime({
        binDir: '/pkg/bin',
        getAgentDir: () => '/agent',
        env: { PATH: '/usr/bin', PI_FORUM_DIR: '/forums/shared' },
        report: (message) => reports.push(message),
        mkdir: () => {},
        createForum: () => forum,
        openBrowser: createBrowserOpener(lib),
        onText: (text) => texts.push(text),
        visibleWidth: lib.visibleWidth,
      })
      // @ts-expect-error -- a session start with only the session ID; PI_FORUM_DIR selects the forum
      runtime.sessionStart({ sessionManager: { getSessionId: () => 's-1' } })
      const browsing = runtime.command('ui', host.ctx)
      await settle()
      await idle(host.component!.browser)
      const before = host.text()
      const renders = host.renders
      await runtime.command(`read ${created[1]!.messages[0]!.id}`, host.ctx)
      assert.equal(texts.length, 1)
      assert.match(texts[0]!, /\nBody \(2 lines\):\nT1 message 0\nsecond line$/)
      assert.deepEqual(reports, [])
      assert.equal(host.focus, 'overlay')
      assert.equal(host.renders, renders)
      assert.equal(host.text(), before)
      await host.press(KEY.escape)
      assert.equal(await browsing, undefined)
      await runtime.command('topics', host.ctx)
      assert.equal(texts.length, 2)
      assert.equal(host.disposals, 1)
      runtime.sessionShutdown()
    })
  })
}

test('printable shows control characters as visible text and leaves other text alone', () => {
  assert.equal(printable('a\x00b\x1b[0m\x7f\x9b\u200f'), 'a␀b␛[0m␡⟨U+009B⟩⟨U+200F⟩')
  assert.equal(printable(BIDI), BIDI_SHOWN)
  assert.equal(printable('日本 👩‍💻 e\u0301  two  spaces'), '日本 👩‍💻 e\u0301  two  spaces')
})

// An entry renderer as these tests call it. It reads only an entry's data and never its theme, so the
// entries carry little else and the theme is empty.
type DrawEntry = (entry: Partial<CustomEntry>, options: EntryRenderOptions, theme: object) => Component | undefined

test('the entry renderer shows every line of a text result unstyled at any width', { skip: !PI_ROOT && 'needs PI_FORUM_TEST_PI_ROOT' }, () => {
  // The installed Pi's pi-tui, which this test needs.
  const lib = libraries.at(-1) as Library & EntryRendererTui
  const render = createEntryRenderer(lib) as DrawEntry
  const body = Array.from({ length: 60 }, (_, i) => `line ${i} ${'日本'.repeat(i % 7)} **not bold**`)
  const text = ['Forum message', '', ...body].join('\n')
  for (const width of [12, 40, 120]) {
    const lines = render({ type: 'custom', customType: ENTRY_TYPE, data: { text } }, { expanded: false }, {})!.render(width)
    assert.ok(lines.length >= body.length + 2)
    for (const line of lines) {
      assert.ok(lib.visibleWidth(line) <= width, JSON.stringify(line))
      assert.doesNotMatch(line, /\x1b/)
    }
    // Wrapping only moves words between rows: every line is there, Markdown included.
    const shown = lines.join('').replaceAll(' ', '')
    for (const line of body) assert.ok(shown.includes(line.replaceAll(' ', '')), line)
  }
  const controls = render({ data: { text: 'a\x1b[31mb\tc‮' } }, { expanded: true }, {})!.render(40)
  assert.deepEqual(controls.map((line) => line.trimEnd()), [' a␛[31mb␉c⟨U+202E⟩'])
  // A stored entry holding every bidirectional control raw draws each as its code point.
  const bidi = render({ data: { text: [...BIDI].map((char) => `x${char}y`).join('\n') } }, { expanded: false }, {})!.render(40)
  assert.deepEqual(
    bidi.map((line) => line.trimEnd()),
    BIDI_CONTROLS.map((code) => ` x⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩y`),
  )
  assert.equal(render({ data: {} }, { expanded: true }, {}), undefined)
})

// Stored data is read as entry.data?.text, so a primitive's text comes from its prototype like any
// other property read; only a nonempty string is drawn.
test('the entry renderer reads text from any stored data as JavaScript does', () => {
  class Text {
    constructor(shown: string, paddingX: number, paddingY: number) {
      Object.assign(this, { shown, paddingX, paddingY })
    }
  }
  // @ts-expect-error -- a Text stand-in that keeps its arguments, not a pi-tui component: the renderer only constructs it
  const render = (data: unknown) => (createEntryRenderer({ Text }) as DrawEntry)({ type: 'custom', customType: ENTRY_TYPE, data }, { expanded: false }, {})
  const drawn = (shown: string) => ({ shown, paddingX: 1, paddingY: 0 })
  for (const data of [undefined, null, 'abc', 5, true, {}, { text: '' }, { text: 7 }, []]) assert.equal(render(data), undefined)
  assert.deepEqual({ ...render(Object.create({ text: 'inherited\x1b' })) }, drawn('inherited␛'))
  assert.deepEqual({ ...render(Object.assign(() => {}, { text: 'function' })) }, drawn('function'))
  try {
    Object.defineProperty(String.prototype, 'text', { value: 'from String\x07', configurable: true, writable: true })
    Object.defineProperty(Number.prototype, 'text', {
      get() {
        return `from ${typeof this} ${this}`
      },
      configurable: true,
    })
    assert.deepEqual({ ...render('abc') }, drawn('from String␇'))
    // The getter runs with the primitive itself as this, as a property read on it does.
    assert.deepEqual({ ...render(5) }, drawn('from number 5'))
    assert.equal(render(null), undefined)
  } finally {
    // @ts-expect-error -- text is no String property: this removes the one defined above
    delete String.prototype.text
    // @ts-expect-error -- text is no Number property: this removes the one defined above
    delete Number.prototype.text
  }
  assert.equal(render('abc'), undefined)
  assert.equal(render(5), undefined)
})
