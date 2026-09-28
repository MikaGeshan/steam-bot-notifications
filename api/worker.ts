import type { IncomingMessage, ServerResponse } from 'node:http'
import { createDependencies } from '../src/dependencies'
import { JobWorker } from '../src/jobs/worker'
import { authorizedCronOrAdmin } from '../src/vercel/node-adapter'

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (!authorizedCronOrAdmin(request)) {
    response.statusCode = 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    return
  }

  const deps = createDependencies()
  try {
    const worker = new JobWorker(deps)
    const url = new URL(request.url ?? '/api/worker', `https://${request.headers.host ?? 'localhost'}`)
    const parsedLimit = Number.parseInt(url.searchParams.get('limit') ?? '10', 10)
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 25)) : 10
    const workerId = `vercel-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
    const processed = await worker.runOnce(workerId, limit)
    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, processed }))
  } finally {
    await deps.sql.end({ timeout: 1 })
  }
}
