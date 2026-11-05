import { parse as parseJsonc } from 'jsonc-parser'

/** Maps a command id to a key such as "cmd+shift+p". An empty string means no shortcut. */
export type KeyMap = Record<string, string>

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'cmd']
const MOD_ALIASES: Record<string, string> = { control: 'ctrl', ctrl: 'ctrl', option: 'alt', opt: 'alt', alt: 'alt', shift: 'shift', cmd: 'cmd', command: 'cmd', meta: 'cmd', win: 'cmd', super: 'cmd' }
const KEY_ALIASES: Record<string, string> = { esc: 'escape', return: 'enter', del: 'delete', ins: 'insert', spacebar: 'space', ' ': 'space', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', pagedown: 'pagedown', pageup: 'pageup', oem_comma: ',', oem_period: '.', plus: '=' }

/** Tidies a key into one spelling. Null for what can't be a single shortcut, such as a two-step chord. */
export function normalizeKey(input: string): string | null {
  const text = input.trim().toLowerCase()
  if (!text || /\S\s+\S/.test(text)) return null
  const parts = text.split('+')
  // "cmd++" ends with an empty part: the key itself is plus.
  const raw = parts[parts.length - 1] === '' ? '=' : parts[parts.length - 1]
  const key = KEY_ALIASES[raw] ?? raw
  const mods = new Set<string>()
  for (const part of parts.slice(0, -1).filter(Boolean)) {
    const mod = MOD_ALIASES[part]
    if (!mod) return null
    mods.add(mod)
  }
  if (!key || MOD_ALIASES[key]) return null
  return [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+')
}

/** Null while only modifier keys are held. Letters come from the physical key, so Option+N isn't read as "ñ". */
export function eventToKey(e: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  const lower = e.key.toLowerCase()
  if (['meta', 'control', 'alt', 'shift', 'os', 'dead', 'unidentified', 'process'].includes(lower)) return null
  const code = e.code ?? ''
  const base = code.startsWith('Key') ? code.slice(3).toLowerCase() : code.startsWith('Digit') ? code.slice(5) : (KEY_ALIASES[lower] ?? lower)
  return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'cmd', base].filter(Boolean).join('+')
}

/** Reads the label a command shows, like ⌘⇧P or Ctrl+Shift+P, as a key. */
export function keyFromLabel(label?: string): string | null {
  if (!label) return null
  const text = label.replace(/⌘/g, 'cmd+').replace(/⇧/g, 'shift+').replace(/⌥/g, 'alt+').replace(/⌃/g, 'ctrl+')
  return normalizeKey(text)
}

const SYMBOLS: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘' }
const WORDS: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Win' }

export function prettyKey(key: string, mac: boolean): string {
  const parts = key.split('+')
  const last = parts.pop() ?? ''
  const name = last.length === 1 ? last.toUpperCase() : last[0].toUpperCase() + last.slice(1)
  return mac ? `${parts.map((m) => SYMBOLS[m]).join('')}${name}` : [...parts.map((m) => WORDS[m]), name].join('+')
}

/** Electron's spelling, for the menu bar. Null if Electron has no name for that key. */
export function toAccelerator(key: string, mac: boolean): string | null {
  const parts = key.split('+')
  const last = parts.pop() ?? ''
  const names: Record<string, string> = { ctrl: 'Control', alt: 'Alt', shift: 'Shift', cmd: mac ? 'Command' : 'Super' }
  const special: Record<string, string> = { escape: 'Esc', enter: 'Return', space: 'Space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', delete: 'Delete', backspace: 'Backspace', tab: 'Tab', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert' }
  const name = special[last] ?? (/^f\d{1,2}$/.test(last) ? last.toUpperCase() : last.length === 1 ? last.toUpperCase() : null)
  return name ? [...parts.map((m) => names[m]), name].join('+') : null
}

/** VS Code's commands that do the same thing as one of ours. */
export const VSCODE_COMMANDS: Record<string, string> = {
  'workbench.action.quickOpen': 'open-file',
  'workbench.action.showCommands': 'palette',
  'workbench.action.toggleSidebarVisibility': 'side',
  'workbench.action.terminal.toggleTerminal': 'terminal',
  'workbench.action.terminal.new': 'new-terminal',
  'workbench.action.splitEditor': 'split',
  'workbench.action.closeActiveEditor': 'close',
  'workbench.action.reopenClosedEditor': 'reopen',
  'workbench.action.nextEditor': 'next',
  'workbench.action.previousEditor': 'prev',
  'workbench.action.files.newUntitledFile': 'new-file',
  'workbench.action.files.openFile': 'open-file-dialog',
  'workbench.action.files.openFolder': 'open-folder',
  'workbench.action.newWindow': 'new-window-empty',
  'workbench.action.findInFiles': 'search',
  'workbench.action.toggleZenMode': 'zen',
  'workbench.action.openSettings': 'settings',
  'workbench.view.scm': 'git-panel',
  'workbench.view.extensions': 'extensions',
  'workbench.view.debug': 'debug',
  'workbench.action.openGlobalKeybindings': 'shortcuts'
}

export interface KeybindingImport {
  bindings: KeyMap
  applied: number
  skipped: string[]
}

/** Reads a VS Code keybindings.json. Editor commands share their names with this app's editor. */
export function parseVscodeKeybindings(text: string, known: (id: string) => boolean): KeybindingImport {
  const list = parseJsonc(text) as { key?: unknown; command?: unknown }[] | undefined
  const bindings: KeyMap = {}
  const skipped: string[] = []
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry?.key !== 'string' || typeof entry.command !== 'string') continue
    if (entry.command.startsWith('-')) continue // a removal of VS Code's own default
    const mapped = VSCODE_COMMANDS[entry.command] ?? (entry.command.startsWith('editor.') ? `editor:${entry.command}` : null)
    const key = normalizeKey(entry.key)
    if (!mapped || !key || !(mapped.startsWith('editor:') || known(mapped))) skipped.push(entry.command)
    else bindings[mapped] = key
  }
  return { bindings, applied: Object.keys(bindings).length, skipped }
}
