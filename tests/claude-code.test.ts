import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeCommand, findClaude } from '../src/main/claude-code'

describe('opening Claude Code', () => {
  it('finds the tool where it is installed, and says when it is missing', () => {
    const expected = path.join('/home/me', '.local', 'bin', 'claude')
    expect(findClaude('/home/me', '/usr/bin', (file) => file === expected, false)).toBe(expected)
    expect(findClaude('/home/me', '', () => false, false)).toBeNull()
  })

  it('types a command the shell reads as one path', () => {
    expect(claudeCommand("/Users/o'b/claude", false)).toBe("'/Users/o'\\''b/claude'")
    expect(claudeCommand('C:\\Users\\me\\claude.exe', true)).toBe('& "C:\\Users\\me\\claude.exe"')
  })
})
