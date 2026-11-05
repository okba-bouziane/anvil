import { parentPort, workerData } from 'node:worker_threads'
import { findScripts, replaceInFiles, searchProject, setScope, walkFiles } from './tools'

const { root, folders, method, args } = workerData as { root: string; folders: string[] | null; method: string; args: unknown[] }

function listFiles(limit: number): string[] {
  const out: string[] = []
  for (const rel of walkFiles(root)) {
    out.push(rel)
    if (out.length >= limit) break
  }
  return out
}

try {
  setScope(root, folders)
  const jobs: Record<string, (...a: never[]) => unknown> = {
    searchProject: (query: string, options: Parameters<typeof searchProject>[2]) => searchProject(root, query, options),
    replaceInFiles: (query: string, options: Parameters<typeof replaceInFiles>[2], replacement: string) => replaceInFiles(root, query, options, replacement),
    findScripts: () => findScripts(root),
    listFiles
  }
  parentPort!.postMessage({ result: jobs[method](...(args as never[])) })
} catch (err) {
  parentPort!.postMessage({ error: (err as Error).message, name: (err as Error).name })
}
