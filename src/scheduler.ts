import { createDependencies } from './dependencies'

const deps = createDependencies()
let running = true

process.on('SIGINT', () => { running = false })
process.on('SIGTERM', () => { running = false })

const bucket = (intervalMinutes: number) =>
  Math.floor(Date.now() / (intervalMinutes * 60_000))

deps.logger.info('scheduler_started')
while (running) {
  const priceInterval = deps.config.scheduler.priceRefreshMinutes
  await deps.repository.enqueueJob('refresh-wishlist', {}, {
    dedupeKey: `refresh-wishlist:${bucket(priceInterval)}`,
    maxAttempts: deps.config.scheduler.jobMaxAttempts,
  })
  await deps.repository.enqueueJob('sync-all-steam', {}, {
    dedupeKey: `sync-all-steam:${bucket(deps.config.scheduler.steamSyncHours * 60)}`,
    maxAttempts: deps.config.scheduler.jobMaxAttempts,
  })

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
  }
  await Bun.sleep(60_000)
}

await deps.sql.end({ timeout: 5 })
deps.logger.info('scheduler_stopped')
