// Fixtures for the real-Pi tests: a synthetic model provider and terminal UI hosts. Only the
// pieces named "fixture" here are stand-ins; everything they drive is Pi's own code.
import { type ChildProcessByStdio, execFile, type SpawnOptions, spawn } from 'node:child_process'
import fs from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'
import type { AssistantMessage, createAssistantMessageEventStream, JsonObject, TextContent } from '@earendil-works/pi-ai'
import type { AgentSession, CustomEntry, ExtensionUIContext, KeybindingsManager, Theme } from '@earendil-works/pi-coding-agent'
import type * as PiTui from '@earendil-works/pi-tui'

const exec = promisify(execFile)

// Extension source for an in-process synthetic provider (test/fixtures/pi-synthetic.ts). Pi registers
// it like any provider extension and its agent loop streams from it; the test decides, through
// globalThis, when each text delta arrives and when the response ends. It never touches the network.
// Both sources are TypeScript, for files named .ts.
export const SYNTHETIC_PROVIDER = fs.readFileSync(new URL('./fixtures/pi-synthetic.ts', import.meta.url), 'utf8')

// The same provider for a Pi subprocess (test/fixtures/pi-file-synthetic.ts), driven through files in
// PI_FORUM_SYNTHETIC_DIR: each delta-N file is streamed in order, and a finish file ends the response.
// Requests, deltas, aborts and the agent's own message updates are appended to log.jsonl there.
export const FILE_SYNTHETIC_PROVIDER = fs.readFileSync(new URL('./fixtures/pi-file-synthetic.ts', import.meta.url), 'utf8')

// One request to the in-process provider: delta(text) and finish() advance Pi's response.
export interface SyntheticCall {
  aborted: boolean
  finished: boolean
  delta(text: string): void
  finish(): void
}

// Installs the in-process provider's stream: each request becomes a call whose delta(text) and
// finish() advance Pi's response. Aborts are recorded, and end the stream as a provider would.
// createStream is the host's own createAssistantMessageEventStream.
export function installSyntheticProvider(createStream: typeof createAssistantMessageEventStream): SyntheticCall[] {
  const calls: SyntheticCall[] = []
  globalThis.piForumSynthetic = {
    stream(model, context, options) {
      const stream = createStream()
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      // The message's one content block, which the deltas extend.
      const text: TextContent = { type: 'text', text: '' }
      const message: AssistantMessage = {
        role: 'assistant',
        content: [text],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      const call: SyntheticCall = {
        aborted: false,
        finished: false,
        delta(delta) {
          text.text += delta
          stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message })
        },
        finish() {
          call.finished = true
          stream.push({ type: 'text_end', contentIndex: 0, content: text.text, partial: message })
          stream.push({ type: 'done', reason: 'stop', message })
          stream.end()
        },
      }
      calls.push(call)
      options?.signal?.addEventListener('abort', () => {
        call.aborted = true
        if (call.finished) return
        message.stopReason = 'aborted'
        message.errorMessage = 'aborted'
        stream.push({ type: 'error', reason: 'aborted', error: message })
        stream.end()
      })
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'text_start', contentIndex: 0, partial: message })
      return stream
    },
  }
  return calls
}

// Removes terminal control sequences, leaving the text a terminal would show.
export const visibleText = (output: string) =>
  output.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')

// The host's pi-tui helpers the terminal UI host uses, and the renderers it runs on.
export type TerminalLibrary = Pick<typeof PiTui, 'truncateToWidth' | 'matchesKey'>
export type Renderer = typeof PiTui.TuiMainScreen | typeof PiTui.TuiAltScreen

// The in-memory terminal: what the renderer wrote, and the input and resize handlers it started with.
export interface MemoryTerminal extends PiTui.Terminal {
  output: string
  onInput?: (data: string) => void
  onResize?: () => void
}

// The editor fixture: the keys it received and the Escs it would have aborted the agent on.
export interface EditorFixture extends PiTui.Component {
  keys: string[]
  escapes: number
}

// The one-line transcript fixture, showing the agent's streamed text.
export interface TranscriptFixture extends PiTui.Component {
  text: string
}

// A component ctx.ui.custom shows, which Pi disposes when the interaction ends.
type CustomComponent = PiTui.Component & { dispose?(): void }

// A custom entry shown: component is undefined when its renderer drew nothing (Pi then shows nothing).
export interface ShownEntry {
  entry: CustomEntry
  component: PiTui.Component | undefined
}

export interface TerminalUI {
  tui: InstanceType<Renderer>
  terminal: MemoryTerminal
  editor: EditorFixture
  transcript: TranscriptFixture
  notices: { type: 'info' | 'warning' | 'error'; message: string }[]
  // The options of each ctx.ui.custom call.
  customs: Parameters<ExtensionUIContext['custom']>[1][]
  // The custom entries shown, in order.
  entries: ShownEntry[]
  // The overlay component and handle of the open interaction, if any.
  component: CustomComponent | null
  handle: PiTui.OverlayHandle | null
  mark: number
  ui: ExtensionUIContext
  written(): string
  screen(): string
  shows(text: string): boolean
  setMark(): void
  type(data: string): void
  overlayFocused(): boolean
  showStreamed(text: string): void
  showEntry(session: AgentSession, entry: CustomEntry): void
  follow(session: AgentSession): () => void
  replay(session: AgentSession): void
  entryLines(index?: number): string[]
  stop(): void
}

// A terminal UI host on Pi's real renderer (pi-tui's TuiMainScreen or TuiAltScreen) and the
// active Pi theme. Fixtures: the in-memory terminal, which records output and delivers typed
// input to the TUI as a real one would; a one-line transcript that renders the agent's streamed
// text; and an editor that, like Pi's, would abort the agent on Esc. custom() follows Pi 1.1.0's
// InteractiveMode.showExtensionCustom for overlays: showOverlay with the given options, and on
// done hideOverlay, resolve, then dispose. Focus and input routing are the TUI's own.
//
// Custom session entries are drawn as Pi 1.1.0's InteractiveMode draws them: follow(session)
// shows each one the session appends (entry_appended), and replay(session) rebuilds them from the
// session's context entries, as renderInitialMessages does after a reload, resume or /tree. Each
// goes through the entry renderer its extension registered, collapsed, above the streamed text.
export function createTerminalUI(
  tuiLib: TerminalLibrary,
  Renderer: Renderer,
  theme: Theme,
  { rows = 40, columns = 100, onEditorEscape }: { rows?: number; columns?: number; onEditorEscape?: () => void },
): TerminalUI {
  const terminal: MemoryTerminal = {
    output: '',
    columns,
    rows,
    kittyProtocolActive: false,
    start(onInput, onResize) {
      this.onInput = onInput
      this.onResize = onResize
    },
    stop() {},
    drainInput: async () => {},
    write(data) {
      this.output += data
    },
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  }
  const tui = new Renderer(terminal)
  const transcript: TranscriptFixture = { text: '', render: (width) => [tuiLib.truncateToWidth(`assistant: ${transcript.text}`, width)], invalidate() {} }
  const editor: EditorFixture = {
    keys: [],
    escapes: 0,
    render: () => ['> '],
    invalidate() {},
    handleInput(data) {
      if (tuiLib.matchesKey(data, 'escape')) {
        editor.escapes++
        onEditorEscape?.()
      } else editor.keys.push(data)
    },
  }
  tui.addChild(transcript)
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()

  // Pi passes custom() factories its keybindings manager; the components shown here never read it.
  const keybindings = {} as KeybindingsManager
  const ui: Pick<ExtensionUIContext, 'notify' | 'custom'> = {
    notify: (message, type = 'info') => host.notices.push({ type, message }),
    custom(factory, options) {
      host.customs.push(options)
      return new Promise((resolve, reject) => {
        let component: CustomComponent | undefined
        let closed = false
        const close = (result: Parameters<Parameters<typeof factory>[3]>[0]) => {
          if (closed) return
          closed = true
          tui.hideOverlay()
          host.component = null
          host.handle = null
          resolve(result)
          try {
            component?.dispose?.()
          } catch {}
        }
        Promise.resolve(factory(tui, theme, keybindings, close))
          .then((created) => {
            if (closed) return
            component = created
            host.component = created
            // Overlay options may be given as a function, which Pi calls as it shows the overlay.
            const overlayOptions = options?.overlayOptions
            host.handle = tui.showOverlay(created, typeof overlayOptions === 'function' ? overlayOptions() : overlayOptions)
          })
          .catch(reject)
      })
    },
  }
  const host: TerminalUI = {
    tui,
    terminal,
    editor,
    transcript,
    notices: [],
    customs: [],
    entries: [],
    component: null,
    handle: null,
    mark: 0,
    // Any other ui method a mode with a UI might call does nothing and returns undefined, so the
    // proxy stands in for the whole ExtensionUIContext.
    ui: new Proxy(ui, {
      get: (target, key) => (key in target ? Reflect.get(target, key) : key === 'then' || typeof key === 'symbol' ? undefined : () => undefined),
    }) as ExtensionUIContext,
    // Text the renderer wrote since the last mark().
    written: () => visibleText(terminal.output.slice(host.mark)),
    // The frame the renderer last drew, from its own public record of the screen.
    screen: () => visibleText(('getScreenLines' in tui ? tui.getScreenLines() : tui.captureRenderState().previousLines).join('\n')),
    // Whether the frame shows text, which may be wrapped across lines.
    shows: (text) => host.screen().replace(/\s+/g, ' ').includes(text),
    setMark() {
      host.mark = terminal.output.length
    },
    // The TUI started the terminal above, so its input handler is set.
    type(data) {
      terminal.onInput!(data)
    },
    // The handle is set together with the component.
    overlayFocused: () => host.component !== null && tui.getFocusedComponent() === host.component && host.handle!.isFocused(),
    showStreamed(text) {
      transcript.text += text
      tui.requestRender()
    },
    showEntry(session, entry) {
      const renderer = session.extensionRunner.getEntryRenderer(entry.customType)
      const component = renderer?.(entry, { expanded: false }, theme)
      host.entries.push({ entry, component })
      if (!component) return
      tui.children.splice(tui.children.indexOf(transcript), 0, component)
      tui.requestRender()
    },
    // Shows the custom entries the session appends from now on; returns the unsubscribe function.
    follow: (session) =>
      session.subscribe((event) => {
        if (event.type === 'entry_appended' && event.entry.type === 'custom') host.showEntry(session, event.entry)
      }),
    replay(session) {
      for (const { component } of host.entries.splice(0)) if (component) tui.removeChild(component)
      for (const entry of session.sessionManager.buildContextEntries()) if (entry.type === 'custom') host.showEntry(session, entry)
    },
    // The rows an entry's component draws at the terminal width, as the terminal shows them; the
    // entry must exist and have drawn a component.
    entryLines: (index = -1) => host.entries.at(index)!.component!.render(columns).map((line) => visibleText(line).trimEnd()),
    stop: () => tui.stop(),
  }
  return host
}

// Polls until check() returns a truthy value, failing after timeoutMs with what was awaited and,
// if given, detail() such as the screen.
export async function until<T>(
  check: () => T | Promise<T>,
  what: string,
  { timeoutMs = 10000, detail }: { timeoutMs?: number; detail?: () => string } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${detail ? `:\n${detail()}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

// Splits a JSONL stream as Pi's JSON and RPC modes frame it: on LF only, with an optional CR before
// it. Every record must be a JSON object; anything else on stdout fails the parse.
export function jsonRecords(stdout: string): JsonObject[] {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line) => {
    const record: unknown = JSON.parse(line.replace(/\r$/, ''))
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error(`not a JSON object record: ${line}`)
    // JSON.parse yields only JSON values, and this one is an object.
    return record as JsonObject
  })
}

// A Pi subprocess in RPC mode, as rpcProcess returns it.
export interface RpcProcess {
  child: ChildProcessByStdio<Writable, Readable, Readable>
  // Every stdout record so far, all of stdout and all of stderr.
  records: JsonObject[]
  stdout: string
  stderr: string
  request(record: JsonObject): Promise<JsonObject>
  close(): Promise<number | null>
  kill(): Promise<number | null>
}

// A Pi subprocess in RPC mode. request(command) writes one command record and resolves with its
// response once Pi sends it; records holds every stdout record so far and stderr all of stderr.
export function rpcProcess(command: string, args: readonly string[], options?: Omit<SpawnOptions, 'stdio'>): RpcProcess {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map<string, (response: JsonObject) => void>()
  let buffered = ''
  let ids = 0
  const rpc: RpcProcess = {
    child,
    records: [],
    stdout: '',
    stderr: '',
    request(record) {
      const id = `req-${++ids}`
      const response = new Promise<JsonObject>((resolve) => waiting.set(id, resolve))
      child.stdin.write(`${JSON.stringify({ id, ...record })}\n`)
      return response
    },
    // Closes stdin, which ends RPC mode, and resolves with the exit code.
    close() {
      child.stdin.end()
      return exited
    },
    kill() {
      if (child.exitCode === null) child.kill()
      return exited
    },
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    rpc.stdout += chunk
    buffered += chunk
    let end
    while ((end = buffered.indexOf('\n')) !== -1) {
      // One complete line is one record.
      const record = jsonRecords(buffered.slice(0, end + 1))[0]!
      buffered = buffered.slice(end + 1)
      rpc.records.push(record)
      const { id } = record
      if (record.type === 'response' && typeof id === 'string' && waiting.has(id)) {
        waiting.get(id)!(record)
        waiting.delete(id)
      }
    }
  })
  child.stderr.on('data', (chunk: string) => {
    rpc.stderr += chunk
  })
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)))
  return rpc
}

// tmux as the terminal for a real Pi subprocess: send keys and read the visible screen.
export async function hasTmux() {
  try {
    await exec('tmux', ['-V'])
    return true
  } catch {
    return false
  }
}

export function tmuxSession(name: string, socket: string) {
  const tmux = (...args: string[]) => exec('tmux', ['-S', socket, ...args])
  return {
    start: (command: string, { cwd, columns = 120, rows = 40 }: { cwd: string; columns?: number; rows?: number }) =>
      tmux('new-session', '-d', '-s', name, '-x', String(columns), '-y', String(rows), '-c', cwd, command),
    keys: (...keys: string[]) => tmux('send-keys', '-t', name, ...keys),
    text: (text: string) => tmux('send-keys', '-t', name, '-l', text),
    screen: async () => (await tmux('capture-pane', '-p', '-t', name)).stdout,
    kill: () => tmux('kill-server').catch(() => {}),
  }
}
