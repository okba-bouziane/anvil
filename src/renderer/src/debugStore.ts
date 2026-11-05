import type { DebugEvent, DebugFrame } from '../../shared/types'

const api = window.anvil

export interface Breakpoint {
  line: number
  condition?: string
}

export type DebugPhase = 'idle' | 'starting' | 'running' | 'paused'

let root = ''
let breakpoints: Record<string, Breakpoint[]> = {}
let phase: DebugPhase = 'idle'
let frames: DebugFrame[] = []
let frameIndex = 0
let threadId = 0
let reason = ''
let output: { category: string; text: string }[] = []
let sessionName = ''
const listeners = new Set<() => void>()
let version = 0
let reveal: (path: string, line: number) => void = () => {}

const notify = () => {
  version++
  listeners.forEach((l) => l())
}
const key = () => `breakpoints:${root}`
const persist = () => void api.uiSet(key(), breakpoints).catch(() => {})

export const debug = {
  subscribe(l: () => void) {
    listeners.add(l)
    return () => listeners.delete(l)
  },
  version: () => version,
  useProject(path: string) {
    root = path
    breakpoints = {}
    void api.uiGet<Record<string, Breakpoint[]>>(key()).then((saved) => {
      if (saved && root === path) {
        breakpoints = saved
        notify()
      }
    }).catch(() => {})
    phase = 'idle'
    frames = []
    output = []
    notify()
  },
  onReveal(run: (path: string, line: number) => void) {
    reveal = run
  },
  all: () => breakpoints,
  forFile: (path: string) => breakpoints[path] ?? [],
  phase: () => phase,
  frames: () => frames,
  frameIndex: () => frameIndex,
  frame: () => frames[frameIndex] ?? null,
  threadId: () => threadId,
  reason: () => reason,
  output: () => output,
  sessionName: () => sessionName,
  toggle(path: string, line: number) {
    const list = breakpoints[path] ?? []
    const next = list.some((b) => b.line === line) ? list.filter((b) => b.line !== line) : [...list, { line }].sort((a, b) => a.line - b.line)
    debug.set(path, next)
  },
  set(path: string, list: Breakpoint[]) {
    if (list.length) breakpoints[path] = list
    else delete breakpoints[path]
    persist()
    notify()
    void api.debugBreakpoints(path, list).catch(() => {})
  },
  setCondition(path: string, line: number, condition: string) {
    debug.set(path, (breakpoints[path] ?? []).map((b) => (b.line === line ? { line, condition: condition.trim() || undefined } : b)))
  },
  clear() {
    for (const path of Object.keys(breakpoints)) debug.set(path, [])
  },
  selectFrame(index: number) {
    frameIndex = index
    const frame = frames[index]
    if (frame?.path) reveal(frame.path, frame.line)
    notify()
  },
  addOutput(category: string, text: string) {
    // Programs color their output for a terminal. This is plain text.
    output = [...output.slice(-1999), { category, text: text.replace(/\x1b\[[0-9;]*m/g, '') }]
    notify()
  },
  clearOutput() {
    output = []
    notify()
  },
  handle(event: DebugEvent) {
    if (event.kind === 'output') return debug.addOutput(event.category, event.text)
    if (event.kind !== 'state') return
    if (event.state === 'starting') {
      phase = 'starting'
      sessionName = event.name
      output = []
      frames = []
    } else if (event.state === 'running') {
      if (phase !== 'idle') phase = 'running'
      frames = []
    } else if (event.state === 'stopped') {
      phase = 'idle'
      frames = []
    } else if (event.state === 'paused') {
      phase = 'paused'
      frames = event.frames
      threadId = event.threadId
      reason = event.description ?? event.reason
      frameIndex = Math.max(0, frames.findIndex((f) => f.path))
      const top = frames[frameIndex]
      if (top?.path) reveal(top.path, top.line)
    }
    notify()
  }
}
