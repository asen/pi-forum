// Pi session entries holding /forum text results, and their transcript renderer.
//
// The runtime's text results are plain, already printable text (output.js). Each is recorded as one
// custom entry, which Pi keeps out of the model's context, and drawn as plain text: no Markdown, no
// styling and no collapsing, so every line is shown whether or not tool output is expanded. Control
// characters are made visible again on render, since a stored entry is read back from the session.

import type { EntryRenderer } from '@earendil-works/pi-coding-agent'
import type { Text } from '@earendil-works/pi-tui'
import { printable } from './output.js'

export const ENTRY_TYPE = 'pi-forum.output'

// What one entry stores. Entries are read back from session files, so the renderer checks it again.
export interface OutputEntryData {
  text: string
}

// The entry data for one text result.
export const entryData = (text: string): OutputEntryData => ({ text })

// The part of Pi's terminal helpers (the @earendil-works/pi-tui module) the renderer uses.
export interface EntryRendererTui {
  readonly Text: typeof Text
}

// Renderer for registerEntryRenderer; takes Pi's terminal helpers, of which it uses Text. Entry data
// is whatever the session holds, so only a nonempty string text is drawn.
export function createEntryRenderer(tui: EntryRendererTui): EntryRenderer<unknown> {
  return function renderEntry(entry) {
    const text = storedText(entry.data)
    if (typeof text !== 'string' || text === '') return undefined
    return new tui.Text(text.split('\n').map(printable).join('\n'), 1, 0)
  }
}

// data?.text, read exactly as JavaScript reads it: undefined for null and undefined, and otherwise the
// value's own or inherited property, a primitive's from its prototype. The result is still unknown;
// the renderer draws it only if it is a string.
function storedText(data: unknown): unknown {
  // Asserted only to allow the property access, not to trust the data: every value other than null
  // and undefined can be read this way, and text is typed unknown.
  return data == null ? undefined : (data as { readonly text?: unknown }).text
}
