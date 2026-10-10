// Stands in for @earendil-works/pi-tui when extension.test.ts loads the extension entry. The browser
// helpers are never called there: the overlay itself is tested in browser-ui.test.ts.
import type * as tui from '@earendil-works/pi-tui'

export const matchesKey: typeof tui.matchesKey = () => {
  throw new Error('matchesKey is not stubbed')
}
export const truncateToWidth: typeof tui.truncateToWidth = () => {
  throw new Error('truncateToWidth is not stubbed')
}
export const wrapTextWithAnsi: typeof tui.wrapTextWithAnsi = () => {
  throw new Error('wrapTextWithAnsi is not stubbed')
}

// Two columns per character, so a test can tell the host's widths from the extension's own.
export const visibleWidth: typeof tui.visibleWidth = (text) => [...text].length * 2

// Keeps the arguments it was constructed with, for the test to read; it draws nothing.
export class Text {
  declare readonly args: ConstructorParameters<typeof tui.Text>
  constructor(...args: ConstructorParameters<typeof tui.Text>) {
    this.args = args
  }
}
