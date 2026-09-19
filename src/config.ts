export type AppConfig = ReturnType<typeof loadConfig>

const integer = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const boolean = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env) {
  const nodeEnv = env.NODE_ENV ?? 'development'
  const useMockProviders = boolean(env.USE_MOCK_PROVIDERS, nodeEnv !== 'production')

  const config = {
    nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port: integer(env.PORT, 3000),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    databaseUrl:
      env.DATABASE_URL ?? 'postgres://steam_bot:steam_bot@localhost:5432/steam_bot',
    databaseMaxConnections: integer(env.DATABASE_MAX_CONNECTIONS, 10),
    logLevel: env.LOG_LEVEL ?? 'info',
    useMockProviders,
    internalApiKey: env.INTERNAL_API_KEY ?? 'local-internal-key',
    adminApiKey: env.ADMIN_API_KEY ?? 'local-admin-key',
    linkTokenSecret: env.LINK_TOKEN_SECRET ?? 'development-link-token-secret-change-me',
    dataEncryptionKey:
      env.DATA_ENCRYPTION_KEY ?? 'development-data-encryption-key-change-me',
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN ?? '',
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? 'change-me',
      botUsername: env.TELEGRAM_BOT_USERNAME ?? '',
    },
    steam: {
      apiKey: env.STEAM_WEB_API_KEY ?? '',
      openIdRealm: env.STEAM_OPENID_REALM ?? env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    },
    itad: {
      apiKey: env.ITAD_API_KEY ?? '',
    },
    scheduler: {
      priceRefreshMinutes: integer(env.PRICE_REFRESH_MINUTES, 60),
      steamSyncHours: integer(env.STEAM_SYNC_HOURS, 24),
      jobPollIntervalMs: integer(env.JOB_POLL_INTERVAL_MS, 1000),
      jobMaxAttempts: integer(env.JOB_MAX_ATTEMPTS, 5),
    },
  } as const

  if (nodeEnv === 'production') {
    const missing = [
      ['DATABASE_URL', env.DATABASE_URL],
      ['INTERNAL_API_KEY', env.INTERNAL_API_KEY],
      ['ADMIN_API_KEY', env.ADMIN_API_KEY],
      ['LINK_TOKEN_SECRET', env.LINK_TOKEN_SECRET],
      ['DATA_ENCRYPTION_KEY', env.DATA_ENCRYPTION_KEY],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name)

    if (!useMockProviders) {
      if (!config.telegram.botToken) missing.push('TELEGRAM_BOT_TOKEN')
      if (!env.TELEGRAM_WEBHOOK_SECRET) missing.push('TELEGRAM_WEBHOOK_SECRET')
      if (!config.steam.apiKey) missing.push('STEAM_WEB_API_KEY')
      if (!config.itad.apiKey) missing.push('ITAD_API_KEY')
    }

    if (missing.length > 0) {
      throw new Error(`Missing production configuration: ${missing.join(', ')}`)
    }
  }

  return config
}
