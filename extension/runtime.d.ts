import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { CreateForumOptions } from '../src/types.js';
import { type BrowserForum } from './browser-state.js';
import type { BindingStatus, ForumBinding, NotifyType, OpenBrowser, PreferenceScope, PreferenceStore, PromptEvent, RuntimeContext, VisibleWidth } from './types.js';
export declare const SECTION_NAME = "forum";
export declare const COMMAND_NAME = "forum";
export declare const USAGE: string;
export type RuntimeReport = (message: string, ctx: RuntimeContext, type?: NotifyType) => void;
export type CreateReader = (options: Pick<CreateForumOptions, 'forumDir'> & {
    createOnRead: false;
}) => BrowserForum;
export interface ForumRuntimeOptions {
    binDir: string;
    getAgentDir: () => string;
    env?: NodeJS.ProcessEnv | undefined;
    report?: RuntimeReport | undefined;
    mkdir?: ((path: string, options: {
        recursive: true;
    }) => unknown) | undefined;
    createForum?: CreateReader | undefined;
    openBrowser?: OpenBrowser | undefined;
    onText?: ((text: string, ctx: RuntimeContext) => void) | undefined;
    visibleWidth?: VisibleWidth | undefined;
    preferences?: PreferenceStore | undefined;
}
export type EffectiveDefault = {
    enabled: true;
    source: 'env';
} | {
    enabled: boolean;
    source: PreferenceScope;
} | {
    enabled: false;
    source: null;
};
export interface RuntimeState {
    status: BindingStatus;
    reason: string | null;
    selected: ForumBinding | null;
}
export interface ForumRuntime {
    readonly binding: ForumBinding | null;
    readonly state: RuntimeState;
    readonly defaults: EffectiveDefault & {
        override: boolean | null;
    };
    sessionStart(ctx: RuntimeContext): void;
    beforeAgentStart(event: PromptEvent, ctx: RuntimeContext): void;
    sessionShutdown(): void;
    command(args: string, ctx: RuntimeContext): Promise<void> | undefined;
}
export declare function createForumRuntime({ binDir, getAgentDir, env, report, mkdir, createForum, openBrowser, onText, visibleWidth, preferences, }: ForumRuntimeOptions): ForumRuntime;
export declare function forumCompletions(prefix: string): AutocompleteItem[];
export interface PromptBinding {
    forumDir: string;
    generated: boolean;
    project?: boolean | undefined;
}
export declare function forumSection({ forumDir, generated, project }: PromptBinding): string;
