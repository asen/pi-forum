export interface CursorData {
    v: 1;
    forum: string;
    offset: number;
}
export declare function encodeCursor(forumId: string, offset: number): string;
export declare function decodeCursor(cursor: string, forumId: string, size: number, byteAt: (position: number) => Promise<number | undefined>): Promise<number>;
