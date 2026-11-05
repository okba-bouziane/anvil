const isMac = window.pitoo.platform === 'darwin'

/** Shortcut labels and the main shortcut key: Command on a Mac, Ctrl elsewhere. */
export const MOD = isMac ? '⌘' : 'Ctrl+'
export const SHIFT = isMac ? '⇧' : 'Shift+'
export const modPressed = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey)
