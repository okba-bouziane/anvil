import { describe, expect, it } from 'vitest'
import { eventToKey, keyFromLabel, normalizeKey, parseVscodeKeybindings, prettyKey, toAccelerator } from '../src/shared/keybindings'

const ev = (key: string, code: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('keyboard shortcuts', () => {
  it('writes every spelling of a key the same way', () => {
    expect(normalizeKey('Shift+Cmd+P')).toBe('shift+cmd+p')
    expect(normalizeKey('meta+shift+p')).toBe('shift+cmd+p')
    expect(normalizeKey('ctrl+ArrowUp')).toBe('ctrl+up')
  })

  it('refuses two-step chords and unknown modifiers', () => {
    expect(normalizeKey('cmd+k cmd+s')).toBeNull()
    expect(normalizeKey('hyper+p')).toBeNull()
    expect(normalizeKey('cmd')).toBeNull()
  })

  it('reads a key press, ignoring modifiers held alone', () => {
    expect(eventToKey(ev('Meta', 'MetaLeft', { metaKey: true }))).toBeNull()
    expect(eventToKey(ev('P', 'KeyP', { metaKey: true, shiftKey: true }))).toBe('shift+cmd+p')
    expect(eventToKey(ev('ñ', 'KeyN', { altKey: true }))).toBe('alt+n')
    expect(eventToKey(ev('ArrowDown', 'ArrowDown'))).toBe('down')
  })

  it('reads the labels commands already show', () => {
    expect(keyFromLabel('⌘⇧P')).toBe('shift+cmd+p')
    expect(keyFromLabel('Ctrl+Shift+P')).toBe('ctrl+shift+p')
    expect(keyFromLabel(undefined)).toBeNull()
  })

  it('shows and exports keys for each system', () => {
    expect(prettyKey('shift+cmd+p', true)).toBe('⇧⌘P')
    expect(prettyKey('ctrl+shift+p', false)).toBe('Ctrl+Shift+P')
    expect(toAccelerator('shift+cmd+p', true)).toBe('Shift+Command+P')
    expect(toAccelerator('ctrl+f5', false)).toBe('Control+F5')
    expect(toAccelerator('cmd+mystery', true)).toBeNull()
  })

  it('imports VS Code keybindings and reports what it could not use', () => {
    const text = `[
      // comment
      { "key": "cmd+t", "command": "workbench.action.quickOpen" },
      { "key": "alt+c", "command": "editor.action.commentLine" },
      { "key": "cmd+k cmd+s", "command": "workbench.action.showCommands" },
      { "key": "cmd+u", "command": "-workbench.action.quickOpen" },
      { "key": "cmd+y", "command": "someExtension.doThing" }
    ]`
    const result = parseVscodeKeybindings(text, () => true)
    expect(result.bindings).toEqual({ 'open-file': 'cmd+t', 'editor:editor.action.commentLine': 'alt+c' })
    expect(result.skipped).toEqual(['workbench.action.showCommands', 'someExtension.doThing'])
    expect(parseVscodeKeybindings('not json', () => true).applied).toBe(0)
  })
})
