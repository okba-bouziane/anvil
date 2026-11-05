import { describe, expect, it } from 'vitest'
import { iconName } from '../src/renderer/src/fileIcons'

describe('iconName', () => {
  const file = (name: string) => iconName(name, false, false, false)

  it('prefers the exact file name', () => {
    expect(file('package.json')).toBe('nodejs')
    expect(file('PACKAGE.JSON')).toBe('nodejs')
  })

  it('prefers the longest extension', () => {
    expect(file('invoice.spec.ts')).toBe('test-ts')
  })

  it('falls back to the language', () => {
    expect(file('invoice.ts')).toBe('typescript')
    expect(file('app.tsx')).toBe('react_ts')
    expect(file('main.py')).toBe('python')
    expect(file('notes.md')).toBe('markdown')
  })

  it('uses a plain icon for anything unknown', () => {
    expect(file('mystery.qqqqq')).toBe('file')
    expect(file('NOTICE_XYZ')).toBe('file')
  })

  it('knows named folders, open and closed', () => {
    expect(iconName('src', true, false, false)).toBe('folder-src')
    expect(iconName('src', true, true, false)).toBe('folder-src-open')
    expect(iconName('zzz', true, false, false)).toBe('folder')
    expect(iconName('zzz', true, true, false)).toBe('folder-open')
  })
})
