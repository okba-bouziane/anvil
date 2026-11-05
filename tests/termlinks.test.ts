import { describe, expect, it } from 'vitest'
import { findTerminalLinks } from '../src/shared/termlinks'

describe('findTerminalLinks', () => {
  it('finds paths with lines, and addresses', () => {
    const [link] = findTerminalLinks('Error in src/app/main.ts:12:4 here', '/p')
    expect(link).toMatchObject({ path: 'src/app/main.ts', line: 12, text: 'src/app/main.ts:12:4', start: 9 })
    expect(findTerminalLinks('see http://localhost:4200/a.js now', '/p')).toEqual([{ text: 'http://localhost:4200/a.js', start: 4, url: 'http://localhost:4200/a.js', line: 1 }])
  })

  it('handles project paths, and ignores others and plain words', () => {
    expect(findTerminalLinks('/p/src/a.ts:3', '/p')[0]).toMatchObject({ path: 'src/a.ts', line: 3 })
    expect(findTerminalLinks('./src/a.ts', '/p')[0]).toMatchObject({ path: 'src/a.ts', line: 1 })
    expect(findTerminalLinks('/etc/hosts.conf', '/p')).toEqual([])
    expect(findTerminalLinks('version 1.2.3 and package.json', '/p')).toEqual([])
  })
})
