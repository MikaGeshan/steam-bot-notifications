export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export async function safeFetch(
  provider: string,
  input: string | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; maxBytes?: number; allowedHosts: string[] },
) {
  const url = new URL(input)
  if (url.protocol !== 'https:' || !options.allowedHosts.includes(url.hostname)) {
    throw new ProviderError(provider, 'disallowed_origin', 'Provider URL is not allowed', false)
  }

  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
  }).catch((error: unknown) => {
    throw new ProviderError(
      provider,
      'network_error',
      error instanceof Error ? error.message : 'Provider network error',
      true,
    )
  })

  if (response.status >= 300 && response.status < 400) {
    throw new ProviderError(provider, 'redirect_rejected', 'Unexpected provider redirect', false)
  }
  if (!response.ok) {
    throw new ProviderError(
      provider,
      `http_${response.status}`,
      `Provider returned HTTP ${response.status}`,
      response.status === 429 || response.status >= 500,
    )
  }

  const declared = Number(response.headers.get('content-length') ?? 0)
  const maxBytes = options.maxBytes ?? 1_000_000
  if (declared > maxBytes) {
    throw new ProviderError(provider, 'response_too_large', 'Provider response is too large', false)
  }
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maxBytes) {
    throw new ProviderError(provider, 'response_too_large', 'Provider response is too large', false)
  }
  return new Response(buffer, { status: response.status, headers: response.headers })
}
