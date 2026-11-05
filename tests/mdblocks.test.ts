import { describe, expect, it } from 'vitest'
import { mdBlocks } from '../src/shared/mdblocks'

describe('chat text blocks', () => {
  it('finds headings, lists and paragraphs', () => {
    expect(mdBlocks('## To try it\n1. Click\n2. Wait\n\nDone\nnow\n\n- a\n- b')).toEqual([
      { kind: 'heading', level: 2, text: 'To try it' },
      { kind: 'list', ordered: true, start: 1, items: ['Click', 'Wait'] },
      { kind: 'text', text: 'Done\nnow' },
      { kind: 'list', ordered: false, start: 1, items: ['a', 'b'] }
    ])
  })

  it('reads tables and rules', () => {
    expect(mdBlocks('| A | B |\n|---|---|\n| 1 | 2 |\n\n---')).toEqual([{ kind: 'table', head: ['A', 'B'], rows: [['1', '2']] }, { kind: 'rule' }])
  })

  it('keeps a numbered list together across blank lines, and indented lines with their item', () => {
    expect(mdBlocks('3. one\n   more\n\n4. two')).toEqual([{ kind: 'list', ordered: true, start: 3, items: ['one\nmore', 'two'] }])
  })

  it('leaves ordinary text alone', () => {
    expect(mdBlocks('a #hash and a - dash\n| not a table')).toEqual([{ kind: 'text', text: 'a #hash and a - dash\n| not a table' }])
  })
})
