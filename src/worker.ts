import { createDependencies } from './dependencies'
import { JobWorker } from './jobs/worker'

const deps = createDependencies()
const worker = new JobWorker(deps)
const workerId = `${process.env.HOSTNAME ?? 'worker'}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`
let running = true

deps.logger.info('worker_started', { workerId })
process.on('SIGINT', () => { running = false })
process.on('SIGTERM', () => { running = false })

while (running) {
  const processed = await worker.runOnce(workerId)
  if (processed === 0) await Bun.sleep(deps.config.scheduler.jobPollIntervalMs)
}

await deps.sql.end({ timeout: 5 })
deps.logger.info('worker_stopped', { workerId })
