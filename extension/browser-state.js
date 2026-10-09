// Navigation and request state for one forum browser, independent of how it is drawn. A renderer
// reads browser.state, calls the actions, redraws on onChange or a subscribe() listener, and ends
// when browser.done settles.
//
// Views form a stack: topics -> a topic's messages -> one message; a browser may also start at
// messages (one topic or all activity) or at a message. List views keep only their current page
// and the start cursors of the pages visited to reach it; Previous and Refresh reread. Back
// restores the parent view with its page and selection, and closes the browser at the root.
//
// Reads go through the bound forum client with the browser's own AbortController: a new load
// aborts the one it supersedes, and closing aborts the current one. Each load has a generation
// token, so completions and warnings from superseded or aborted loads are ignored. The lifetime
// signal (the runtime's per-selection signal) closes the browser when it aborts; the browser never
// aborts or reuses any other signal.
export const PAGE_SIZE = 20;
export const WARNING_LIMIT = 20;
const isList = (frame) => frame.kind !== 'message';
export function createBrowser({ forum, target, view, signal, pageSize = PAGE_SIZE, warningLimit = WARNING_LIMIT, onChange = () => { }, }) {
    const own = new AbortController();
    const frames = [initialFrame(view)];
    let generation = 0;
    let current = null;
    let closeReason = null;
    let resolveDone;
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    const onLifetimeEnd = () => close('discarded');
    const listeners = new Set();
    // The stack always keeps its root: Back there closes the browser instead of popping it.
    const top = () => frames.at(-1);
    function notify() {
        if (closeReason)
            return;
        onChange();
        for (const listener of [...listeners])
            listener();
    }
    // Starts reading the top view's current page or message; resolves once it settles or is superseded.
    function load() {
        if (closeReason)
            return Promise.resolve();
        current?.abort();
        const controller = new AbortController();
        current = controller;
        const token = ++generation;
        const frame = top();
        const warnings = { items: [], omitted: 0 };
        frame.status = 'loading';
        frame.error = null;
        frame.warnings = warnings;
        const live = () => token === generation && !closeReason;
        const options = {
            signal: AbortSignal.any([own.signal, controller.signal]),
            onWarning(message) {
                if (!live())
                    return;
                if (warnings.items.length < warningLimit)
                    warnings.items.push(message);
                else
                    warnings.omitted++;
                notify();
            },
        };
        notify();
        return Promise.resolve()
            .then(() => read(frame, options))
            .then((result) => {
            if (!live())
                return;
            if (isList(frame)) {
                // read() resolves a list frame with a page of its own items.
                const page = result;
                frame.items = page.items;
                frame.nextCursor = page.next_cursor;
                frame.selection = Math.max(0, Math.min(frame.selection, page.items.length - 1));
            }
            else {
                frame.message = result;
            }
            frame.status = 'ready';
            notify();
        }, (err) => {
            if (!live())
                return;
            if (isList(frame))
                frame.items = null;
            else
                frame.message = null;
            frame.status = 'error';
            frame.error = describeError(err, frame, target);
            notify();
        })
            .finally(() => {
            if (current === controller)
                current = null;
        });
    }
    function read(frame, options) {
        const page = { after: isList(frame) ? frame.cursors[frame.pageIndex] : undefined, limit: pageSize };
        if (frame.kind === 'topics')
            return forum.listTopics({ ...options, ...page });
        if (frame.kind === 'messages')
            return forum.listMessages({ ...options, ...page, topicId: frame.topicId });
        return forum.getMessage(frame.messageId, options);
    }
    // Abandons any load in flight, e.g. before showing a view that is already loaded.
    function supersede() {
        generation++;
        current?.abort();
        current = null;
    }
    function close(reason = 'closed') {
        if (closeReason)
            return;
        closeReason = reason;
        generation++;
        own.abort();
        current = null;
        listeners.clear();
        signal?.removeEventListener('abort', onLifetimeEnd);
        resolveDone(reason);
    }
    function canNext(frame) {
        return isList(frame) && frame.status === 'ready' && frame.items.length === pageSize;
    }
    const browser = {
        get closed() {
            return closeReason !== null;
        },
        // Why the browser closed: 'closed' (Esc), 'back' (Back at the root), 'discarded' (the selection
        // ended), or whatever the caller passed to close().
        get closeReason() {
            return closeReason;
        },
        // Resolves with the close reason once the browser closes.
        done,
        // Calls listener after each state change until it unsubscribes or the browser closes.
        subscribe(listener) {
            if (closeReason)
                return () => { };
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        // What a renderer draws; a fresh snapshot each time.
        get state() {
            const frame = top();
            const list = isList(frame);
            // Each frame keeps the correlations BrowserState adds: its view and page or message match its
            // kind, and only a failed read has an error.
            return {
                closed: closeReason !== null,
                // Where the client resolved is known after its first successful read.
                target: { ...target, resolved: forum.resolved },
                atRoot: frames.length === 1,
                view: viewOf(frame),
                status: frame.status,
                error: frame.error,
                warnings: { items: [...frame.warnings.items], omitted: frame.warnings.omitted },
                page: list
                    ? {
                        index: frame.pageIndex,
                        items: frame.items ?? [],
                        selection: frame.selection,
                        caughtUp: frame.status === 'ready' && frame.items.length < pageSize,
                    }
                    : null,
                message: list ? null : frame.message,
                actions: {
                    open: list && frame.status === 'ready' && frame.items.length > 0,
                    previous: list && frame.pageIndex > 0,
                    next: canNext(frame),
                    back: true,
                    refresh: frame.status !== 'error',
                    retry: frame.status === 'error' && frame.error.code !== 'INVALID_CURSOR',
                    restart: list && (frame.pageIndex > 0 || frame.error?.code === 'INVALID_CURSOR'),
                    close: true,
                },
            };
        },
        start() {
            return load();
        },
        select(index) {
            const frame = top();
            if (closeReason || !isList(frame) || !frame.items?.length)
                return;
            frame.selection = Math.max(0, Math.min(index, frame.items.length - 1));
            notify();
        },
        moveSelection(delta) {
            const frame = top();
            // A message view has no selection (undefined + delta is NaN), and select ignores it.
            browser.select((isList(frame) ? frame.selection : NaN) + delta);
        },
        // Opens the selected row: a topic's messages, or a message's complete record.
        open() {
            const frame = top();
            if (closeReason || !browser.state.actions.open)
                return Promise.resolve();
            // Open applies only to a ready list, which has a row at its selection.
            const { kind, items, selection } = frame;
            frames.push(kind === 'topics'
                ? listFrame({ kind: 'messages', topicId: items[selection].id, topic: items[selection] })
                : { kind: 'message', messageId: items[selection].id, message: null, ...pending() });
            return load();
        },
        next() {
            const frame = top();
            if (closeReason || !canNext(frame))
                return Promise.resolve();
            // canNext: a ready list, whose nextCursor is the one its read returned.
            const list = frame;
            list.cursors.push(list.nextCursor);
            list.pageIndex++;
            list.selection = 0;
            list.items = null;
            return load();
        },
        previous() {
            const frame = top();
            if (closeReason || !isList(frame) || frame.pageIndex === 0)
                return Promise.resolve();
            frame.cursors.pop();
            frame.pageIndex--;
            frame.selection = 0;
            frame.items = null;
            return load();
        },
        // Rereads the current page from its start cursor, forgetting pages after it, or the message.
        refresh() {
            if (closeReason)
                return Promise.resolve();
            const frame = top();
            if (isList(frame))
                frame.cursors.length = frame.pageIndex + 1;
            return load();
        },
        retry() {
            return browser.refresh();
        },
        // Starts the list again from its first page, e.g. after INVALID_CURSOR.
        restart() {
            const frame = top();
            if (closeReason || !isList(frame))
                return Promise.resolve();
            frame.cursors = [undefined];
            frame.pageIndex = 0;
            frame.selection = 0;
            frame.items = null;
            return load();
        },
        // Returns to the parent view as it was left; at the root, closes the browser.
        back() {
            if (closeReason)
                return;
            if (frames.length === 1) {
                close('back');
                return;
            }
            supersede();
            frames.pop();
            if (top().status === 'loading')
                load();
            else
                notify();
        },
        close,
    };
    if (signal?.aborted)
        close('discarded');
    else
        signal?.addEventListener('abort', onLifetimeEnd, { once: true });
    return browser;
}
function pending() {
    return { status: 'loading', error: null, warnings: { items: [], omitted: 0 } };
}
function listFrame({ kind, topicId, topic }) {
    // The overloads pair kind with its topicId and topic.
    return {
        kind,
        topicId,
        topic,
        // Start cursors of the pages visited, up to the current one.
        cursors: [undefined],
        pageIndex: 0,
        items: null,
        nextCursor: null,
        selection: 0,
        ...pending(),
    };
}
function initialFrame(view) {
    if (view.kind === 'topics')
        return listFrame({ kind: 'topics' });
    if (view.kind === 'messages')
        return listFrame({ kind: 'messages', topicId: view.topicId });
    return { kind: 'message', messageId: view.messageId, message: null, ...pending() };
}
// Messages views without a topicId show activity across the forum; each record has its topic_id.
function viewOf(frame) {
    if (frame.kind === 'topics')
        return { kind: 'topics' };
    if (frame.kind === 'messages')
        return { kind: 'messages', topicId: frame.topicId, topic: frame.topic };
    return { kind: 'message', messageId: frame.messageId };
}
// The error a view shows, naming the forum it read and what can be done next.
function describeError(err, frame, target) {
    const code = errorField(err, 'code') ?? 'ERROR';
    return {
        code,
        message: errorField(err, 'message') ?? String(err),
        forumDir: target.forumDir,
        actions: code === 'INVALID_CURSOR'
            ? ['restart', 'back']
            : ['retry', ...(frame.kind !== 'message' && frame.pageIndex > 0 ? ['restart'] : []), 'back'],
    };
}
// err?.[name] for any thrown value, read exactly as JavaScript reads it: undefined for null and
// undefined, and otherwise the value's own or inherited property, if any.
function errorField(err, name) {
    // Asserted only to allow the property access; no value other than null or undefined fails it.
    return err == null ? undefined : err[name];
}
