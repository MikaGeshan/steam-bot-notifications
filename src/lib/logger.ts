type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const priorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const redact = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/\b\d{8,20}\b/g, '[NUMERIC_ID_REDACTED]')
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|secret|password|authorization|address/i.test(key) ? '[REDACTED]' : redact(item),
      ]),
    )
  }
  return value
}

export function createLogger(minimum: string = 'info') {
  const threshold = priorities[minimum as LogLevel] ?? priorities.info

  const write = (level: LogLevel, message: string, context: Record<string, unknown> = {}) => {
    if (priorities[level] < threshold) return
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...redact(context) as Record<string, unknown>,
    }
    const output = JSON.stringify(entry)
    if (level === 'error') console.error(output)
    else if (level === 'warn') console.warn(output)
    else console.log(output)
  }

  return {
    debug: (message: string, context?: Record<string, unknown>) => write('debug', message, context),
    info: (message: string, context?: Record<string, unknown>) => write('info', message, context),
    warn: (message: string, context?: Record<string, unknown>) => write('warn', message, context),
    error: (message: string, context?: Record<string, unknown>) => write('error', message, context),
  }
}

export type Logger = ReturnType<typeof createLogger>
