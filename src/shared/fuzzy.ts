/** Scores how well a query matches a path, like Go to File in other editors. Null means no match. */
export function fuzzyScore(query: string, file: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const text = file.toLowerCase()
  const nameAt = text.lastIndexOf('/') + 1
  let score = 0
  let from = 0
  let last = -2
  for (const char of q) {
    const at = text.indexOf(char, from)
    if (at < 0) return null
    if (at === last + 1) score += 8 // letters side by side
    if (at === nameAt || '/-_.'.includes(text[at - 1] ?? '/')) score += 6 // the start of a word
    if (at >= nameAt) score += 3 // in the file's name, not its folders
    score -= Math.min(at - from, 6) * 0.2 // a long gap counts against it
    last = at
    from = at + 1
  }
  if (text.slice(nameAt).startsWith(q)) score += 20
  return score - text.length * 0.01
}

export function fuzzyFilter(query: string, files: string[], limit = 12): string[] {
  if (!query.trim()) return files.slice(0, limit)
  const scored: { file: string; score: number }[] = []
  for (const file of files) {
    const score = fuzzyScore(query, file)
    if (score !== null) scored.push({ file, score })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.file)
}
