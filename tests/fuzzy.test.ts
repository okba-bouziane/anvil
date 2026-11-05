import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyScore } from '../src/shared/fuzzy'

describe('Go to File matching', () => {
  it('matches letters in order, even with gaps, and rejects the rest', () => {
    expect(fuzzyScore('apts', 'src/app.ts')).not.toBeNull()
    expect(fuzzyScore('zzz', 'src/app.ts')).toBeNull()
  })

  it('prefers the file name over its folders', () => {
    expect(fuzzyFilter('app', ['app/deep/other.ts', 'src/app.ts'])[0]).toBe('src/app.ts')
  })

  it('finds initials across words', () => {
    expect(fuzzyFilter('uc', ['src/misc.ts', 'src/user-card.tsx'])[0]).toBe('src/user-card.tsx')
  })

  it('lists files in their order when nothing is typed', () => {
    expect(fuzzyFilter(' ', ['b', 'a'], 1)).toEqual(['b'])
  })
})
