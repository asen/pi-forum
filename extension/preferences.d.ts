import type { PreferenceScope, PreferenceStore, PreferenceStoreOptions } from './types.js';
export declare const PREFERENCES_FILE = "forum.json";
export declare const SCOPES: readonly PreferenceScope[];
export declare function createPreferenceStore({ getAgentDir, fs }: PreferenceStoreOptions): PreferenceStore;
