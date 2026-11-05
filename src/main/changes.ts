import fs from 'node:fs'
import path from 'node:path'
import { applyPatch, reversePatch, structuredPatch, type StructuredPatch } from 'diff'
import type { Checkpoint, FileChange, Hunk } from '../shared/types'

/** Content a file had before an edit. null means the file did not exist. */
type Content = string | null

export interface ChangeState {
  baselines: Record<string, Content>
  checkpoints: (Checkpoint & { before: Record<string, Content> })[]
}

const read = (file: string): Content => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Edits go to disk straight away, so builds and checks see them. The baseline is what the file held
 * before review, so the pending change is always baseline vs disk. Accepting moves the baseline
 * forward; rejecting moves the disk back.
 */
export class ChangeTracker {
  private baselines = new Map<string, Content>()
  private checkpoints: ChangeState['checkpoints'] = []
  private current: ChangeState['checkpoints'][number] | null = null

  constructor(private root: string, state?: ChangeState) {
    if (state) {
      this.baselines = new Map(Object.entries(state.baselines))
      this.checkpoints = state.checkpoints
    }
  }

  toJSON(): ChangeState {
    return { baselines: Object.fromEntries(this.baselines), checkpoints: this.checkpoints }
  }

  private abs(rel: string): string {
    return path.join(this.root, rel)
  }

  beginCheckpoint(id: string, title: string): void {
    this.current = { id, title, files: [], undone: false, before: {} }
  }

  /** Returns the finished checkpoint, or null if the step changed no files. */
  endCheckpoint(): Checkpoint | null {
    const done = this.current
    this.current = null
    if (!done || done.files.length === 0) return null
    this.checkpoints.push(done)
    // Older steps stop being undoable as a whole; each file's own Keep and Undo still works.
    if (this.checkpoints.length > 50) this.checkpoints.shift()
    return { id: done.id, title: done.title, files: done.files, undone: false }
  }

  /** The one way files change: records what is needed for review and undo, then writes. */
  write(rel: string, content: string): void {
    const file = this.abs(rel)
    const before = read(file)
    if (!this.baselines.has(rel)) this.baselines.set(rel, before)
    if (this.current && !(rel in this.current.before)) {
      this.current.before[rel] = before
      this.current.files.push(rel)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    this.settle(rel)
  }

  /** A pending change that nets out to nothing is not a change. */
  private settle(rel: string): void {
    if (this.baselines.has(rel) && this.baselines.get(rel) === read(this.abs(rel))) this.baselines.delete(rel)
  }

  private restore(rel: string, content: Content): void {
    const file = this.abs(rel)
    if (content === null) {
      fs.rmSync(file, { force: true })
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }

  private patch(rel: string): StructuredPatch | null {
    if (!this.baselines.has(rel)) return null
    const original = this.baselines.get(rel) ?? ''
    const modified = read(this.abs(rel)) ?? ''
    return structuredPatch(rel, rel, original, modified, '', '', { context: 2 })
  }

  list(): FileChange[] {
    const out: FileChange[] = []
    for (const [rel, baseline] of this.baselines) {
      const now = read(this.abs(rel))
      const hunks: Hunk[] = (this.patch(rel)?.hunks ?? []).map((h, index) => ({
        index,
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        firstChangedLine: h.newStart + Math.max(0, h.lines.findIndex((l) => l[0] === '+' || l[0] === '-')),
        added: h.lines.filter((l) => l.startsWith('+')).length,
        removed: h.lines.filter((l) => l.startsWith('-')).length
      }))
      out.push({
        path: rel,
        status: baseline === null ? 'added' : now === null ? 'deleted' : 'modified',
        added: hunks.reduce((n, h) => n + h.added, 0),
        removed: hunks.reduce((n, h) => n + h.removed, 0),
        hunks
      })
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  listCheckpoints(): Checkpoint[] {
    return this.checkpoints.map(({ id, title, files, undone }) => ({ id, title, files, undone }))
  }

  diff(rel: string): { original: string; modified: string } {
    const modified = read(this.abs(rel)) ?? ''
    return { original: this.baselines.has(rel) ? (this.baselines.get(rel) ?? '') : modified, modified }
  }

  acceptFile(rel: string): void {
    this.baselines.delete(rel)
  }

  rejectFile(rel: string): void {
    if (!this.baselines.has(rel)) return
    this.restore(rel, this.baselines.get(rel) ?? null)
    this.baselines.delete(rel)
  }

  /** The user renamed or deleted this path, so it is no longer a change to review. */
  forgetUnder(rel: string): void {
    for (const key of [...this.baselines.keys()]) {
      if (key === rel || key.startsWith(`${rel}/`)) this.baselines.delete(key)
    }
  }

  acceptAll(): void {
    this.baselines.clear()
  }

  rejectAll(): void {
    for (const rel of [...this.baselines.keys()]) this.rejectFile(rel)
  }

  private single(rel: string, index: number): StructuredPatch {
    const patch = this.patch(rel)
    const hunk = patch?.hunks[index]
    if (!patch || !hunk) throw new Error(`No change ${index + 1} in ${rel}`)
    return { ...patch, hunks: [hunk] }
  }

  acceptHunk(rel: string, index: number): void {
    const next = applyPatch(this.baselines.get(rel) ?? '', this.single(rel, index))
    if (next === false) throw new Error(`Could not accept this change in ${rel}`)
    this.baselines.set(rel, next)
    this.settle(rel)
  }

  rejectHunk(rel: string, index: number): void {
    const reversed = reversePatch(this.single(rel, index)) as StructuredPatch
    const next = applyPatch(read(this.abs(rel)) ?? '', reversed)
    if (next === false) throw new Error(`Could not reject this change in ${rel}`)
    const baseline = this.baselines.get(rel)
    // Rejecting the last change of a new file removes the file rather than leaving it empty.
    if (next === (baseline ?? '')) {
      this.restore(rel, baseline ?? null)
      this.baselines.delete(rel)
      return
    }
    fs.writeFileSync(this.abs(rel), next)
  }

  /** Puts files back as they were before this step, undoing any later steps with it. */
  undoCheckpoint(id: string): void {
    const start = this.checkpoints.findIndex((c) => c.id === id)
    if (start < 0) throw new Error('This step can no longer be undone')
    for (let i = this.checkpoints.length - 1; i >= start; i--) {
      const cp = this.checkpoints[i]
      if (cp.undone) continue
      for (const [rel, content] of Object.entries(cp.before)) {
        this.restore(rel, content)
        this.settle(rel)
      }
      cp.undone = true
    }
  }
}
