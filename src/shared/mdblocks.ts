export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'text'; text: string }

const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBER = /^\s*(\d+)[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s*([-*_])\1{2,}\s*$/
const TABLE_LINE = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?$/

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

/** Splits the parts of a model's answer that aren't code into blocks. The result is shown as text, never as HTML. */
export function mdBlocks(source: string): MdBlock[] {
  const lines = source.split('\n')
  const out: MdBlock[] = []
  let para: string[] = []
  const flush = () => {
    const text = para.join('\n').trim()
    if (text) out.push({ kind: 'text', text })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const heading = line.match(HEADING)
    if (heading) {
      flush()
      out.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
    } else if (RULE.test(line)) {
      flush()
      out.push({ kind: 'rule' })
    } else if (TABLE_LINE.test(line) && TABLE_RULE.test(lines[i + 1] ?? '')) {
      flush()
      const rows: string[][] = []
      let j = i + 2
      for (; j < lines.length && TABLE_LINE.test(lines[j]); j++) rows.push(cells(lines[j]))
      out.push({ kind: 'table', head: cells(line), rows })
      i = j - 1
    } else if (BULLET.test(line) || NUMBER.test(line)) {
      flush()
      const ordered = NUMBER.test(line)
      const pattern = ordered ? NUMBER : BULLET
      const items: string[] = []
      const start = ordered ? Number(line.match(NUMBER)![1]) : 1
      let j = i
      for (; j < lines.length; j++) {
        const match = lines[j].match(pattern)
        if (match) items.push(match[match.length - 1])
        // A blank line between items doesn't end the list, and an indented line belongs to the item above.
        else if (!lines[j].trim() && pattern.test(lines[j + 1] ?? '')) continue
        else if (/^\s{2,}\S/.test(lines[j]) && items.length) items[items.length - 1] += `\n${lines[j].trim()}`
        else break
      }
      out.push({ kind: 'list', ordered, start, items })
      i = j - 1
    } else if (!line.trim()) {
      flush()
    } else {
      para.push(line)
    }
  }
  flush()
  return out
}
