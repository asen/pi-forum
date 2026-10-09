// The terminal forum browser: one overlay component drawing a browser-state controller.
//
// It takes Pi's terminal helpers (the @earendil-works/pi-tui module: matchesKey, truncateToWidth,
// visibleWidth, wrapTextWithAnsi) as an argument, so it imports nothing from Pi itself. Forum text
// is peer data: control characters are shown as visible symbols before any styling, and it is only
// drawn, never sent to the editor, the session or a model.
import { expandTabs, printable } from './output.js';
export { printable };
// The overlay's share of the terminal; the component draws exactly the rows Pi gives the overlay.
const WIDTH = '90%';
const HEIGHT_PERCENT = 80;
// Opener for createForumRuntime: shows the browser in one ctx.ui.custom overlay and resolves when
// the interaction ends, whether by Esc, Back at the root or the browser closing from outside.
export function createBrowserOpener(tui) {
    return async function openBrowser({ browser, ctx }) {
        await ctx.ui.custom((host, theme, _keybindings, done) => new ForumBrowserView({ browser, host, theme, done, tui }), { overlay: true, overlayOptions: { anchor: 'center', width: WIDTH, maxHeight: `${HEIGHT_PERCENT}%` } });
    };
}
// Rows the overlay gets, as Pi computes a percentage maxHeight.
export function overlayHeight(host) {
    const rows = host.terminal?.rows ?? 24;
    return Math.max(1, Math.min(rows, Math.floor((rows * HEIGHT_PERCENT) / 100)));
}
class ForumBrowserView {
    constructor({ browser, host, theme, done, tui }) {
        this.browser = browser;
        this.host = host;
        this.theme = theme;
        this.done = done;
        this.tui = tui;
        this.finished = false;
        // Body scroll position, for the message it belongs to.
        this.scroll = { messageId: null, top: 0 };
        this.bodyCache = null;
        // Rows the last render gave the list or the body, for paging keys.
        this.listRows = 1;
        this.bodyRows = 1;
        this.maxScroll = 0;
        this.bodyPosition = null;
        this.unsubscribe = browser.subscribe(() => {
            this.invalidate();
            host.requestRender();
        });
        browser.done.then(() => this.finish());
        browser.start();
    }
    // Ends the Pi interaction once; Pi then disposes the component and restores focus.
    finish() {
        if (this.finished)
            return;
        this.finished = true;
        this.unsubscribe();
        this.done(this.browser.closeReason);
    }
    dispose() {
        this.finished = true;
        this.unsubscribe();
        this.browser.close();
    }
    invalidate() {
        this.bodyCache = null;
    }
    handleInput(data) {
        if (this.finished)
            return;
        const key = (...ids) => ids.some((id) => this.tui.matchesKey(data, id));
        const { browser } = this;
        const { actions, view } = browser.state;
        if (key('escape', 'q'))
            browser.close();
        else if (key('backspace', 'b'))
            browser.back();
        else if (key('r') && actions.retry)
            browser.retry();
        else if (key('r') && actions.refresh)
            browser.refresh();
        else if (key('s') && actions.restart)
            browser.restart();
        else if (view.kind === 'message')
            this.scrollBody(data);
        else if (key('enter') && actions.open)
            browser.open();
        else if (key('right', 'n') && actions.next)
            browser.next();
        else if (key('left', 'p') && actions.previous)
            browser.previous();
        else
            this.moveSelection(data);
        // Close and Back at the root end the browser; end the interaction now rather than a tick later.
        if (browser.closed)
            this.finish();
    }
    // Reached only from a list view, which has a page.
    moveSelection(data) {
        const { page } = this.browser.state;
        const key = (id) => this.tui.matchesKey(data, id);
        const step = Math.max(1, this.listRows);
        if (key('up'))
            this.browser.moveSelection(-1);
        else if (key('down'))
            this.browser.moveSelection(1);
        else if (key('pageUp'))
            this.browser.moveSelection(-step);
        else if (key('pageDown'))
            this.browser.moveSelection(step);
        else if (key('home'))
            this.browser.select(0);
        else if (key('end'))
            this.browser.select(page.items.length - 1);
    }
    scrollBody(data) {
        const key = (id) => this.tui.matchesKey(data, id);
        const step = Math.max(1, this.bodyRows - 1);
        const deltas = [
            ['up', -1],
            ['down', 1],
            ['pageUp', -step],
            ['pageDown', step],
            ['home', -Infinity],
            ['end', Infinity],
        ];
        for (const [id, delta] of deltas) {
            if (key(id)) {
                // End stays at the bottom even if the next render wraps the body into more lines.
                this.scroll.top = delta === Infinity ? Infinity : Math.max(0, Math.min(this.scroll.top + delta, this.maxScroll));
                return;
            }
        }
    }
    render(width) {
        width = Math.max(1, width);
        const height = overlayHeight(this.host);
        const state = this.browser.state;
        const { theme } = this;
        const fit = (text) => this.tui.truncateToWidth(text, width, '…', true);
        const line = (text, color) => (color ? theme.fg(color, fit(text)) : fit(text));
        const header = [theme.bold(line(title(state), 'accent'))];
        header.push(line(directory(state.target), 'muted'));
        header.push(state.target.warning ? line(participation(state.target), 'warning') : line(participation(state.target), 'dim'));
        const { items, omitted } = state.warnings;
        if (items.length) {
            const count = items.length + omitted;
            header.push(line(`${count} damaged record(s) skipped: ${printable(items[0])}`, 'warning'));
        }
        // The help line and at least one content row come first; header rows fill what is left.
        const footer = height >= 3 ? 1 : 0;
        const shown = header.slice(0, Math.max(0, Math.min(header.length, height - footer - 1)));
        const rows = height - footer - shown.length;
        const content = this.content(state, width, rows, fit, line);
        const lines = [...shown, ...content.slice(0, rows)];
        while (lines.length < height - footer)
            lines.push(fit(''));
        if (footer)
            lines.push(line(this.help(state), 'dim'));
        return lines;
    }
    content(state, width, rows, fit, line) {
        const { theme } = this;
        if (state.status === 'error') {
            const { code, message, forumDir } = state.error;
            const wrapped = this.wrap(`${code}: ${message}`, width).map((text) => theme.fg('error', fit(text)));
            return [...wrapped, line(`Forum directory: ${printable(forumDir)}`, 'muted')];
        }
        if (reading(state))
            return this.reader(state, width, rows, fit, line);
        this.listRows = rows;
        const { items, selection, caughtUp } = state.page;
        if (items.length === 0) {
            if (state.status === 'loading')
                return [line('Loading…', 'muted')];
            const empty = state.view.kind === 'topics' ? 'No topics yet.' : 'No messages yet.';
            return [line(caughtUp ? `${empty} You are caught up; r refreshes.` : empty, 'muted')];
        }
        const start = Math.max(0, Math.min(selection - Math.floor(rows / 2), items.length - rows));
        return items.slice(start, start + rows).map((item, i) => {
            const selected = start + i === selection;
            const text = fit(`${selected ? '› ' : '  '}${summary(item, state.view)}`);
            return selected ? theme.bg('selectedBg', theme.fg('accent', text)) : theme.fg('text', text);
        });
    }
    reader(state, width, rows, fit, line) {
        const { message } = state;
        this.bodyRows = 1;
        this.maxScroll = 0;
        if (!message)
            return [line('Loading message…', 'muted')];
        const reply = message.reply_to ? ` · reply to ${message.reply_to}` : '';
        const meta = [
            line(`From ${printable(message.author)} · ${printable(message.created_at)}`, 'muted'),
            line(`Topic ${printable(message.topic_id)}${printable(reply)}`, 'muted'),
        ].slice(0, Math.max(0, rows - 1));
        const body = this.body(message, width);
        const viewport = Math.max(1, rows - meta.length);
        if (this.scroll.messageId !== message.id)
            this.scroll = { messageId: message.id, top: 0 };
        this.bodyRows = viewport;
        this.maxScroll = Math.max(0, body.length - viewport);
        this.scroll.top = Math.min(this.scroll.top, this.maxScroll);
        this.bodyPosition = { first: this.scroll.top + 1, last: Math.min(body.length, this.scroll.top + viewport), total: body.length };
        return [...meta, ...body.slice(this.scroll.top, this.scroll.top + viewport).map((text) => this.theme.fg('text', fit(text)))];
    }
    // The body as plain display lines for width, kept until the message, width or theme changes.
    body(message, width) {
        if (this.bodyCache?.id === message.id && this.bodyCache.width === width)
            return this.bodyCache.lines;
        const lines = [];
        for (const raw of message.body.split('\n'))
            lines.push(...this.wrap(expandTabs(raw, this.tui.visibleWidth), width));
        this.bodyCache = { id: message.id, width, lines };
        return lines;
    }
    wrap(text, width) {
        const shown = printable(text);
        return shown === '' ? [''] : this.tui.wrapTextWithAnsi(shown, width);
    }
    help(state) {
        const { actions, view, atRoot } = state;
        const parts = [];
        if (state.status === 'error') {
            if (actions.retry)
                parts.push('r retry');
            if (actions.restart)
                parts.push('s restart');
        }
        else if (view.kind === 'message') {
            const { first, last, total } = this.bodyPosition ?? { first: 0, last: 0, total: 0 };
            if (total)
                parts.push(`${first}-${last}/${total}${last < total ? ' ↓' : ''}${first > 1 ? ' ↑' : ''}`);
            parts.push('↑↓ PgUp PgDn Home End scroll');
            if (actions.refresh)
                parts.push('r refresh');
        }
        else {
            if (actions.open)
                parts.push('↑↓ select · Enter open');
            if (actions.previous)
                parts.push('← prev');
            if (actions.next)
                parts.push('→ next');
            if (actions.refresh)
                parts.push('r refresh');
            if (actions.restart)
                parts.push('s restart');
        }
        parts.push(atRoot ? 'b/Esc close' : 'b back · Esc close');
        return parts.join(' · ');
    }
}
// state.view.kind === 'message', which narrows the view but not the state it belongs to.
function reading(state) {
    return state.view.kind === 'message';
}
function title({ view, page, status }) {
    const name = view.kind === 'topics'
        ? 'Topics'
        : view.kind === 'message'
            ? `Message ${view.messageId}`
            : view.topic
                ? `Messages in "${view.topic.title}"`
                : view.topicId === undefined
                    ? 'All activity'
                    : `Messages in topic ${view.topicId}`;
    const where = page ? ` · page ${page.index + 1}` : '';
    return printable(`Forum · ${name}${where}${status === 'loading' ? ' · loading…' : ''}`);
}
function directory({ forumDir, resolved }) {
    const real = resolved && resolved !== forumDir ? ` → ${resolved}` : '';
    return printable(`Directory: ${forumDir}${real}`);
}
function participation({ status, warning }) {
    if (warning)
        return printable(`Unavailable: ${warning}; browsing the last selected directory`);
    return status === 'on' ? 'Forum is on for agents' : 'Forum is off for agents; browsing only';
}
const short = (id) => (id.length > 8 ? id.slice(0, 8) : id);
const day = (iso) => iso.replace('T', ' ').slice(0, 16);
// One list row; activity across topics names each message's topic. The page of a topics view holds
// topics and that of a messages view messages, so item is asserted to the view's kind.
function summary(item, view) {
    if (view.kind === 'topics') {
        const topic = item;
        return printable(`${topic.title} · ${topic.created_by} · ${day(topic.created_at)} · ${short(topic.id)}`);
    }
    const message = item;
    const topic = view.topicId === undefined ? ` · topic ${short(message.topic_id)}` : '';
    const [first] = message.body.split('\n');
    return printable(`${message.author} · ${day(message.created_at)}${topic} · ${first}`);
}
