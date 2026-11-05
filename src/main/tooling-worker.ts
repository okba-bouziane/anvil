import { parentPort, workerData } from 'node:worker_threads'
import { Tooling } from './tooling'

const tooling = new Tooling(workerData.root)

parentPort!.on('message', async ({ id, method, args }: { id: number; method: 'lint' | 'fixAll' | 'format'; args: [string, string] }) => {
  try {
    parentPort!.postMessage({ id, result: await tooling[method](...args) })
  } catch (err) {
    parentPort!.postMessage({ id, error: (err as Error).message })
  }
})
