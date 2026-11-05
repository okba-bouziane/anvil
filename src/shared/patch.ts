export interface LineChange {
  originalStart: number
  /** Zero means nothing was removed, and the block goes after originalStart. */
  originalEnd: number
  modifiedStart: number
  /** Zero means nothing was added, and the block was after modifiedStart. */
  modifiedEnd: number
}

const header = (path: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`

function body(lines: string[], from: number, to: number, mark: string): string {
  let out = ''
  for (let i = from; i <= to; i++) out += `${mark}${lines[i - 1] ?? ''}\n`
  return out
}

/** A patch with no surrounding context for one block of a change. It adds the block to whatever HEAD or the index has. */
export function blockPatch(path: string, original: string, modified: string, change: LineChange): string {
  const before = original.split('\n')
  const after = modified.split('\n')
  const removed = change.originalEnd === 0 ? 0 : change.originalEnd - change.originalStart + 1
  const added = change.modifiedEnd === 0 ? 0 : change.modifiedEnd - change.modifiedStart + 1
  const hunk = `@@ -${change.originalStart},${removed} +${change.modifiedStart},${added} @@\n`
  return header(path) + hunk + (removed ? body(before, change.originalStart, change.originalEnd, '-') : '') + (added ? body(after, change.modifiedStart, change.modifiedEnd, '+') : '')
}
