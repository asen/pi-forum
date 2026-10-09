import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export type ForumExtensionAPI = Pick<ExtensionAPI, 'on' | 'registerCommand' | 'registerEntryRenderer' | 'appendEntry'>;
export default function piForum(pi: ForumExtensionAPI): void;
