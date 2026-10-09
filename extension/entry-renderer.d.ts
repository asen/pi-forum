import type { EntryRenderer } from '@earendil-works/pi-coding-agent';
import type { Text } from '@earendil-works/pi-tui';
export declare const ENTRY_TYPE = "pi-forum.output";
export interface OutputEntryData {
    text: string;
}
export declare const entryData: (text: string) => OutputEntryData;
export interface EntryRendererTui {
    readonly Text: typeof Text;
}
export declare function createEntryRenderer(tui: EntryRendererTui): EntryRenderer<unknown>;
