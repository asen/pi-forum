import type { CreateForumOptions, Forum } from './types.js';
export type Environment = {
    readonly [name: string]: string | undefined;
};
export interface OutputWriter {
    write(chunk: string): void;
}
export type ForumFactory = (options: CreateForumOptions) => Forum;
export interface MainOptions {
    createForum?: ForumFactory | undefined;
    stdout?: OutputWriter | undefined;
    stderr?: OutputWriter | undefined;
}
export declare function main(argv: readonly string[], env?: Environment, { createForum: bind, stdout, stderr }?: MainOptions): Promise<number>;
