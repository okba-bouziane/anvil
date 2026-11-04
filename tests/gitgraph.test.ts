import { expect, it } from 'vitest'
import { layoutGraph } from '../src/shared/gitgraph'

const c = (sha: string, ...parents: string[]) => ({ sha, parents })

it('keeps a straight history in one column', () => {
  const rows = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')])
  expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
  expect(rows[0].top).toEqual([])
  expect(rows[1].top).toEqual([0])
  expect(rows[2].bottom).toEqual([])
})

it('gives a branch its own column, and merges it back', () => {
  const rows = layoutGraph([c('m', 'y', 'x'), c('x', 'b'), c('y', 'b'), c('b')])
  expect(rows[0].lane).toBe(0)
  expect(rows[0].bottom).toEqual([{ from: 0, to: 0 }, { from: 0, to: 1 }])
  expect(rows[1].lane).toBe(1)
  expect(rows[2].lane).toBe(0)
  expect(rows[3].lane).toBe(0)
  expect(rows[3].top).toEqual([0, 1])
})

it('reuses a free column, and handles a branch tip with no children', () => {
  const rows = layoutGraph([c('p', 'a'), c('q', 'a'), c('a')])
  expect(rows.map((r) => r.lane)).toEqual([0, 1, 0])
  expect(rows[1].lanes).toBe(2)
})

it('copes with no commits', () => expect(layoutGraph([])).toEqual([]))
