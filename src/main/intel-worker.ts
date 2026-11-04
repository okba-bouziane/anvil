import ts from 'typescript'
import { parentPort, workerData } from 'node:worker_threads'
import { Intel } from './intel'

const intel = new Intel(workerData.root, ts)

parentPort!.on('message', ({ id, method, args }: { id: number; method: keyof Intel; args: unknown[] }) => {
  try {
    const result = (intel[method] as (...a: unknown[]) => unknown).apply(intel, args)
    parentPort!.postMessage({ id, result })
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message })
  }
})
