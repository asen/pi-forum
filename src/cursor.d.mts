// Consumer contract of cursor.mjs: encoding and checking the JSONL backend's cursors.

// Cursors are opaque to callers: base64url JSON { v: 1, forum, offset }, where forum is the
// SHA-256 of the forum's real directory and offset is a byte position after a complete line.
export interface CursorData {
  v: 1
  forum: string
  offset: number
}

export declare function encodeCursor(forumId: string, offset: number): string

// Returns the cursor's byte offset after checking it against this forum and a log snapshot of size
// bytes; byteAt(position) resolves to one byte of that snapshot.
export declare function decodeCursor(
  cursor: string,
  forumId: string,
  size: number,
  byteAt: (position: number) => Promise<number | undefined>,
): Promise<number>
