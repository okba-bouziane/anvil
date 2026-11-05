export interface TerminalLink {
  text: string
  start: number
  url?: string
  path?: string
  line: number
}

/** Web addresses and project file paths in a line of terminal output, like src/app.ts:12:4 in an error. */
export function findTerminalLinks(text: string, root: string): TerminalLink[] {
  const links: TerminalLink[] = []
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)]+/g)) links.push({ text: m[0], start: m.index, url: m[0], line: 1 })
  for (const m of text.matchAll(/(?<![\w/:.-])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z]\w*)(?::(\d+))?(?::\d+)?/g)) {
    const overlaps = links.some((l) => m.index >= l.start && m.index < l.start + l.text.length)
    if (overlaps || (!m[1].includes('/') && !m[2])) continue
    const inside = m[1].startsWith(`${root}/`)
    if (m[1].startsWith('/') && !inside) continue
    links.push({ text: m[0], start: m.index, path: inside ? m[1].slice(root.length + 1) : m[1].replace(/^\.\//, ''), line: Number(m[2] ?? 1) })
  }
  return links
}
