import { createApp } from './app'
import { createDependencies } from './dependencies'

const dependencies = createDependencies()
const app = createApp(dependencies)

app.listen({ hostname: dependencies.config.host, port: dependencies.config.port })
dependencies.logger.info('api_started', {
  host: dependencies.config.host,
  port: dependencies.config.port,
  mockProviders: dependencies.config.useMockProviders,
})

const shutdown = async () => {
  dependencies.logger.info('api_stopping')
  await app.stop(true)
  await dependencies.sql.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

export type App = typeof app
