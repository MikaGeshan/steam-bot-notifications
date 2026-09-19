import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { loadConfig } from '../config'
import { createDatabase } from './client'

export async function migrate() {
  const config = loadConfig()
  const sql = createDatabase(config)
  const directory = join(import.meta.dir, 'migrations')

  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()
    for (const file of files) {
      const applied = await sql`SELECT 1 FROM schema_migrations WHERE version = ${file}`
      if (applied.length > 0) continue
      const contents = await Bun.file(join(directory, file)).text()
      await sql.begin(async (transaction) => {
        await transaction.unsafe(contents)
        await transaction`INSERT INTO schema_migrations (version) VALUES (${file})`
      })
      console.log(JSON.stringify({ level: 'info', message: 'migration_applied', version: file }))
    }
  } finally {
    await sql.end()
  }
}

if (import.meta.main) {
  await migrate()
}
