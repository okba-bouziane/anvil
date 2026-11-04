export interface CommitNode {
  sha: string
  parents: string[]
}

export interface GraphRow {
  /** The column this commit's dot sits in. */
  lane: number
  /** Lines running through the top half of the row, from the row above into a column. */
  top: number[]
  /** Lines running through the bottom half of the row, from one column to another. */
  bottom: { from: number; to: number }[]
  lanes: number
}

/** Lays out commits, newest first, into columns, keeping a branch in one column as long as it can. */
export function layoutGraph(commits: CommitNode[]): GraphRow[] {
  const lanes: (string | null)[] = []
  return commits.map((commit) => {
    const top = lanes.flatMap((sha, i) => (sha ? [i] : []))
    let lane = lanes.indexOf(commit.sha)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) lane = lanes.length
      lanes[lane] = commit.sha
    }
    const bottom: GraphRow['bottom'] = []
    // Other branches that end at this commit join its column.
    lanes.forEach((sha, i) => {
      if (sha === commit.sha && i !== lane) lanes[i] = null
    })
    const merging = top.filter((i) => i !== lane && !lanes[i])
    lanes[lane] = commit.parents[0] ?? null
    if (commit.parents[0]) bottom.push({ from: lane, to: lane })
    for (const parent of commit.parents.slice(1)) {
      let to = lanes.indexOf(parent)
      if (to < 0) {
        to = lanes.indexOf(null)
        if (to < 0) to = lanes.length
        lanes[to] = parent
      }
      bottom.push({ from: lane, to })
    }
    lanes.forEach((sha, i) => {
      if (sha && i !== lane && !bottom.some((b) => b.to === i)) bottom.push({ from: i, to: i })
    })
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop()
    const count = Math.max(lane + 1, ...top.map((i) => i + 1), ...bottom.map((b) => Math.max(b.from, b.to) + 1), merging.length ? Math.max(...merging) + 1 : 0)
    return { lane, top, bottom, lanes: count }
  })
}
