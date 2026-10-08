// Fixtures for the real-Pi tests: a synthetic model provider and terminal UI hosts. Only the
// pieces named "fixture" here are stand-ins; everything they drive is Pi's own code.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

// Extension source for an in-process synthetic provider. Pi registers it like any provider
// extension and its agent loop streams from it; the test decides, through globalThis, when each
// text delta arrives and when the response ends. It never touches the network.
export const SYNTHETIC_PROVIDER = `export default function (pi) {
  pi.registerProvider('forum-synthetic', {
    baseUrl: 'http://127.0.0.1:9/unused',
    apiKey: 'synthetic-key',
    api: 'forum-synthetic',
    models: [{ id: 'held', name: 'Held stream', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple: (model, context, options) => globalThis.piForumSynthetic.stream(model, context, options),
  })
}
`

// The same provider for a Pi subprocess, driven through files in PI_FORUM_SYNTHETIC_DIR: each
// delta-N file is streamed in order, and a finish file ends the response. Requests, deltas,
// aborts and the agent's own message updates are appended to log.jsonl there.
export const FILE_SYNTHETIC_PROVIDER = `import fs from 'node:fs'
import path from 'node:path'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'

const dir = process.env.PI_FORUM_SYNTHETIC_DIR
const log = (entry) => fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\\n')

export default function (pi) {
  let calls = 0
  pi.registerProvider('forum-synthetic', {
    baseUrl: 'http://127.0.0.1:9/unused',
    apiKey: 'synthetic-key',
    api: 'forum-synthetic',
    models: [{ id: 'held', name: 'Held stream', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const call = ++calls
      log({ event: 'request', call })
      const stream = createAssistantMessageEventStream()
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const message = { role: 'assistant', content: [{ type: 'text', text: '' }], api: model.api, provider: model.provider, model: model.id, usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } }, stopReason: 'stop', timestamp: Date.now() }
      let sent = 0
      const timer = setInterval(() => {
        const next = path.join(dir, 'delta-' + (sent + 1))
        if (fs.existsSync(next)) {
          const delta = fs.readFileSync(next, 'utf8')
          sent++
          message.content[0].text += delta
          stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: message })
          log({ event: 'delta', call, n: sent })
        } else if (fs.existsSync(path.join(dir, 'finish'))) {
          clearInterval(timer)
          stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message })
          stream.push({ type: 'done', reason: 'stop', message })
          stream.end()
          log({ event: 'done', call })
        }
      }, 20)
      options?.signal?.addEventListener('abort', () => {
        clearInterval(timer)
        log({ event: 'abort', call })
        message.stopReason = 'aborted'
        message.errorMessage = 'aborted'
        stream.push({ type: 'error', reason: 'aborted', error: message })
        stream.end()
      })
      stream.push({ type: 'start', partial: message })
      stream.push({ type: 'text_start', contentIndex: 0, partial: message })
      return stream
    },
  })
  pi.on('message_update', (event) => {
    if (event.assistantMessageEvent?.type === 'text_delta') log({ event: 'message_update', delta: event.assistantMessageEvent.delta })
  })
  pi.on('agent_end', () => log({ event: 'agent_end' }))
}
`

// Installs the in-process provider's stream: each request becomes a call whose delta(text) and
// finish() advance Pi's response. Aborts are recorded, and end the stream as a provider would.
export function installSyntheticProvider(createAssistantMessageEventStream) {
  const calls = []
  globalThis.piForumSynthetic = {
    stream(model, context, options) {
      const stream = createAssistantMessageEventStream()
      const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const message = {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      const call = {
        aborted: false,
        finished: false,
        delta(text) {
          message.content[0].text += text
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message })
        },
        finish() {
          call.finished = true
          stream.push({ type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message })
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
export const visibleText = (output) =>
  output.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')

// A terminal UI host on Pi's real renderer (pi-tui's TuiMainScreen or TuiAltScreen) and the
// active Pi theme. Fixtures: the in-memory terminal, which records output and delivers typed
// input to the TUI as a real one would; a one-line transcript that renders the agent's streamed
// text; and an editor that, like Pi's, would abort the agent on Esc. custom() follows Pi 1.1.0's
// InteractiveMode.showExtensionCustom for overlays: showOverlay with the given options, and on
// done hideOverlay, resolve, then dispose. Focus and input routing are the TUI's own.
export function createTerminalUI(tuiLib, Renderer, theme, { rows = 40, columns = 100, onEditorEscape }) {
  const terminal = {
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
  const transcript = { text: '', render: (width) => [tuiLib.truncateToWidth(`assistant: ${transcript.text}`, width)], invalidate() {} }
  const editor = {
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

  const host = {
    tui,
    terminal,
    editor,
    transcript,
    notices: [],
    customs: [],
    // The overlay component and handle of the open interaction, if any.
    component: null,
    handle: null,
    mark: 0,
    ui: {
      notify: (message, type = 'info') => host.notices.push({ type, message }),
      custom(factory, options) {
        host.customs.push(options)
        return new Promise((resolve, reject) => {
          let component
          let closed = false
          const close = (result) => {
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
          Promise.resolve(factory(tui, theme, {}, close))
            .then((created) => {
              if (closed) return
              component = created
              host.component = created
              host.handle = tui.showOverlay(created, options?.overlayOptions)
            })
            .catch(reject)
        })
      },
    },
    // Text the renderer wrote since the last mark().
    written: () => visibleText(terminal.output.slice(host.mark)),
    // The frame the renderer last drew, from its own public record of the screen.
    screen: () => visibleText((tui.getScreenLines?.() ?? tui.captureRenderState().previousLines).join('\n')),
    // Whether the frame shows text, which may be wrapped across lines.
    shows: (text) => host.screen().replace(/\s+/g, ' ').includes(text),
    setMark() {
      host.mark = terminal.output.length
    },
    type(data) {
      terminal.onInput(data)
    },
    overlayFocused: () => host.component !== null && tui.getFocusedComponent() === host.component && host.handle.isFocused(),
    showStreamed(text) {
      transcript.text += text
      tui.requestRender()
    },
    stop: () => tui.stop(),
  }
  // Any other ui method a mode with a UI might call.
  host.ui = new Proxy(host.ui, {
    get: (target, key) => (key in target ? target[key] : key === 'then' || typeof key === 'symbol' ? undefined : () => undefined),
  })
  return host
}

// Polls until check() returns a truthy value, failing after timeoutMs with what was awaited and,
// if given, detail() such as the screen.
export async function until(check, what, { timeoutMs = 10000, detail } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${detail ? `:\n${detail()}` : ''}`)
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
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

export function tmuxSession(name, socket) {
  const tmux = (...args) => exec('tmux', ['-S', socket, ...args])
  return {
    start: (command, { cwd, columns = 120, rows = 40 }) =>
      tmux('new-session', '-d', '-s', name, '-x', String(columns), '-y', String(rows), '-c', cwd, command),
    keys: (...keys) => tmux('send-keys', '-t', name, ...keys),
    text: (text) => tmux('send-keys', '-t', name, '-l', text),
    screen: async () => (await tmux('capture-pane', '-p', '-t', name)).stdout,
    kill: () => tmux('kill-server').catch(() => {}),
  }
}
