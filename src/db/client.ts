import postgres, { type Sql } from 'postgres'
import type { AppConfig } from '../config'

export type Database = Sql<Record<string, never>>

export function createDatabase(config: AppConfig): Database {
  return postgres(config.databaseUrl, {
    max: config.databaseMaxConnections,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => undefined,
  })
}
