import type { Theme } from '@earendil-works/pi-coding-agent';
import type { matchesKey, TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { printable } from './output.js';
import type { OpenBrowserRequest } from './types.js';
export { printable };
export interface BrowserTui {
    readonly matchesKey: typeof matchesKey;
    readonly truncateToWidth: typeof truncateToWidth;
    readonly visibleWidth: typeof visibleWidth;
    readonly wrapTextWithAnsi: typeof wrapTextWithAnsi;
}
export interface BrowserHost {
    readonly terminal?: {
        readonly rows?: TUI['terminal']['rows'] | undefined;
    } | undefined;
    requestRender(): void;
}
export type BrowserTheme = Pick<Theme, 'fg' | 'bg' | 'bold'>;
export declare function createBrowserOpener(tui: BrowserTui): (request: Pick<OpenBrowserRequest, 'browser' | 'ctx'>) => Promise<void>;
export declare function overlayHeight(host: Pick<BrowserHost, 'terminal'>): number;
