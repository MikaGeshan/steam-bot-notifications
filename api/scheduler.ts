import type { IncomingMessage, ServerResponse } from 'node:http'
import { createDependencies } from '../src/dependencies'
import { authorizedCronOrAdmin } from '../src/vercel/node-adapter'

const bucket = (intervalMinutes: number) =>
  Math.floor(Date.now() / (intervalMinutes * 60_000))

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  if (!authorizedCronOrAdmin(request)) {
    response.statusCode = 401
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    return
  }

  const deps = createDependencies()
  const enqueued: string[] = []
  try {
    const priceInterval = deps.config.scheduler.priceRefreshMinutes
    await deps.repository.enqueueJob('refresh-wishlist', {}, {
      dedupeKey: `refresh-wishlist:${bucket(priceInterval)}`,
      maxAttempts: deps.config.scheduler.jobMaxAttempts,
    })
    enqueued.push('refresh-wishlist')

    await deps.repository.enqueueJob('sync-all-steam', {}, {
      dedupeKey: `sync-all-steam:${bucket(deps.config.scheduler.steamSyncHours * 60)}`,
      maxAttempts: deps.config.scheduler.jobMaxAttempts,
    })
    enqueued.push('sync-all-steam')

    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta',
      weekday: 'short',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(new Date())
    if (local.startsWith('Mon') && local.endsWith('09')) {
      await deps.repository.enqueueJob('weekly-reports', {}, {
        dedupeKey: `weekly-reports:${new Date().toISOString().slice(0, 10)}`,
        maxAttempts: deps.config.scheduler.jobMaxAttempts,
      })
      enqueued.push('weekly-reports')
    }

    response.statusCode = 200
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ok: true, enqueued }))
  } finally {
    await deps.sql.end({ timeout: 1 })
  }
}
