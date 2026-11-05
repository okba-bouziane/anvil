export interface ConflictBlock {
  /** Line numbers count from 1, like the editor's. */
  start: number
  separator: number
  end: number
  /** The `|||||||` line of diff3-style conflicts, when there is one. */
  base: number | null
}

export type ConflictChoice = 'current' | 'incoming' | 'both'

/** Finds the conflict blocks Git left in a file. A block with no end is not a conflict and is ignored. */
export function findConflicts(text: string): ConflictBlock[] {
  const blocks: ConflictBlock[] = []
  let open: Partial<ConflictBlock> | null = null
  text.split(/\r?\n/).forEach((line, i) => {
    const number = i + 1
    if (line.startsWith('<<<<<<< ') || line === '<<<<<<<') open = { start: number, base: null }
    else if (open && open.separator === undefined && (line.startsWith('||||||| ') || line === '|||||||')) open.base = number
    else if (open && open.separator === undefined && line === '=======') open.separator = number
    else if (open && open.separator !== undefined && (line.startsWith('>>>>>>> ') || line === '>>>>>>>')) {
      blocks.push({ start: open.start!, separator: open.separator, end: number, base: open.base ?? null })
      open = null
    }
  })
  return blocks
}

/** The lines that replace a block for a given choice. */
export function resolvedLines(lines: string[], block: ConflictBlock, choice: ConflictChoice): string[] {
  const current = lines.slice(block.start, (block.base ?? block.separator) - 1)
  const incoming = lines.slice(block.separator, block.end - 1)
  if (choice === 'current') return current
  if (choice === 'incoming') return incoming
  return [...current, ...incoming]
}
