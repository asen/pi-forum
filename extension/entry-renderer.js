// Pi session entries holding /forum text results, and their transcript renderer.
//
// The runtime's text results are plain, already printable text (output.js). Each is recorded as one
// custom entry, which Pi keeps out of the model's context, and drawn as plain text: no Markdown, no
// styling and no collapsing, so every line is shown whether or not tool output is expanded. Control
// characters are made visible again on render, since a stored entry is read back from the session.

import { printable } from './output.js'

export const ENTRY_TYPE = 'pi-forum.output'

// The entry data for one text result.
export const entryData = (text) => ({ text })

// Renderer for registerEntryRenderer; takes Pi's terminal helpers (the @earendil-works/pi-tui
// module), of which it uses Text.
export function createEntryRenderer(tui) {
  return function renderEntry(entry) {
    const text = entry.data?.text
    if (typeof text !== 'string' || text === '') return undefined
    return new tui.Text(text.split('\n').map(printable).join('\n'), 1, 0)
  }
}
