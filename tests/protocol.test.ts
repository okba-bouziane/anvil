import { describe, expect, it } from 'vitest'
import { ToolTagParser } from '../src/main/protocol'

function run(chunks: string[], finish = true) {
  const out = { text: '', body: '', opened: [] as string[] }
  const parser = new ToolTagParser({
    onText: (d) => { out.text += d },
    onToolOpen: (n) => out.opened.push(n),
    onToolBody: (d) => { out.body += d }
  })
  let stopped = false
  for (const c of chunks) if ((stopped = parser.feed(c))) break
  if (finish && !stopped) parser.finish()
  return { ...out, call: parser.call, stopped }
}
const oneByOne = (s: string) => [...s]

describe('ToolTagParser', () => {
  it('passes plain text through', () => {
    const r = run(oneByOne('Hello <b>there</b> a < b'))
    expect(r.text).toBe('Hello <b>there</b> a < b')
    expect(r.call).toBeNull()
  })

  it('reads a self-closing tag, however it is split', () => {
    for (const chunks of [oneByOne('Let me look.\n<read_file path="src/a.ts"/>'), ['Let me look.\n<read_file path="src/a.ts"/>']]) {
      const r = run(chunks)
      expect(r.text).toBe('Let me look.\n')
      expect(r.call).toMatchObject({ name: 'read_file', args: { path: 'src/a.ts' } })
      expect(r.stopped).toBe(true)
    }
  })

  it('streams a file body and stops at its end', () => {
    const r = run(oneByOne('<write_file path="a.ts">\nconst x = 1 < 2\n</write_file>\nand then invented text'))
    expect(r.call?.args).toEqual({ path: 'a.ts', content: 'const x = 1 < 2\n' })
    expect(r.body).toContain('const x = 1 < 2')
    expect(r.body).not.toContain('</write_file>')
  })

  it('keeps HTML inside a file', () => {
    const r = run(oneByOne('<write_file path="a.html"><div class="a">x</div></write_file>'))
    expect(r.call?.args.content).toBe('<div class="a">x</div>\n')
  })

  it('removes a code fence around file contents', () => {
    const r = run(['<write_file path="a.ts">\n```ts\nconst a = 1\n```\n</write_file>'])
    expect(r.call?.args.content).toBe('const a = 1\n')
  })

  it('reads an edit', () => {
    const r = run(oneByOne('<edit_file path="a.ts">\n<old>let a</old>\n<new>const a</new>\n</edit_file>'))
    expect(r.call?.args).toEqual({ path: 'a.ts', old_string: 'let a', new_string: 'const a' })
  })

  it('keeps inner line breaks in an edit', () => {
    const r = run(['<edit_file path="a"><old>\n  a\n  b\n</old><new>\n  c\n</new></edit_file>'])
    expect(r.call?.args).toMatchObject({ old_string: '  a\n  b', new_string: '  c' })
  })

  it('reads a command', () => {
    expect(run(['<run_command>npm test</run_command>']).call?.args.command).toBe('npm test')
  })

  it('accepts unquoted attributes and a > inside a value', () => {
    expect(run(['<read_file path=a.ts start_line=4/>']).call?.args).toEqual({ path: 'a.ts', start_line: '4' })
    expect(run(['<search_code query="a > b"/>']).call?.args.query).toBe('a > b')
  })

  it('uses what it has when the model stops mid-file', () => {
    const r = run(['<write_file path="a.ts">const a'])
    expect(r.call?.args.content).toBe('const a\n')
  })

  it('does not treat other tags as tools', () => {
    expect(run(['<read_filesystem x="1"/>']).call).toBeNull()
  })
})
