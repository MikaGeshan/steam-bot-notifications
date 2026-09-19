import { timingSafeEqualString } from '../../lib/crypto'
import type { MessagingProvider, ParsedMessagingWebhook } from '../../ports'
import { ProviderError } from '../http'

type TelegramUser = {
  id?: number
  is_bot?: boolean
}

type TelegramChat = {
  id?: number
  type?: string
}

type TelegramMessage = {
  message_id?: number
  date?: number
  chat?: TelegramChat
  from?: TelegramUser
  text?: string
}

type TelegramUpdate = {
  update_id?: number
  message?: TelegramMessage
  callback_query?: {
    id?: string
    from?: TelegramUser
    message?: TelegramMessage
    data?: string
  }
}

type TelegramApiResponse<T> = {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const timestampFrom = (seconds: number | undefined) =>
  Number.isSafeInteger(seconds) && Number(seconds) > 0
    ? new Date(Number(seconds) * 1_000).toISOString()
    : new Date().toISOString()

const privateChatAddress = (chat: TelegramChat | undefined, actor: TelegramUser | undefined) => {
  if (
    chat?.type !== 'private' ||
    !Number.isSafeInteger(chat.id) ||
    Number(chat.id) <= 0 ||
    !Number.isSafeInteger(actor?.id) ||
    actor?.is_bot === true ||
    Number(actor?.id) !== Number(chat.id)
  ) return null
  return String(chat.id)
}

export class TelegramBotProvider implements MessagingProvider {
  readonly name = 'telegram-bot'

  constructor(
    private readonly settings: {
      botToken: string
      webhookSecret: string
    },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async verifyWebhook(secret: string | null) {
    if (!this.settings.webhookSecret || !secret) return false
    return timingSafeEqualString(secret, this.settings.webhookSecret)
  }

  parseWebhook(payload: unknown): ParsedMessagingWebhook {
    if (!payload || typeof payload !== 'object') throw new Error('Invalid Telegram update')
    const update = payload as TelegramUpdate
    if (!Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0) {
      throw new Error('Invalid Telegram update_id')
    }

    const eventId = String(update.update_id)
    const messageAddress = privateChatAddress(update.message?.chat, update.message?.from)
    const messageText = update.message?.text?.trim()
    if (messageAddress && messageText) {
      return {
        messages: [{
          eventId,
          address: messageAddress,
          text: messageText,
          timestamp: timestampFrom(update.message?.date),
        }],
      }
    }

    const callback = update.callback_query
    const callbackAddress = privateChatAddress(callback?.message?.chat, callback?.from)
    const callbackData = callback?.data?.trim()
    if (callback?.id && callbackAddress && callbackData && callback?.from?.is_bot !== true) {
      return {
        messages: [{
          eventId,
          address: callbackAddress,
          text: callbackData,
          timestamp: timestampFrom(undefined),
          interactionId: callback.id,
        }],
      }
    }

    return { messages: [] }
  }

  private async call<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.settings.botToken) {
      throw new ProviderError(this.name, 'not_configured', 'Telegram Bot API is not configured', false)
    }

    let response: Response
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.settings.botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: AbortSignal.timeout(8_000),
      })
    } catch {
      throw new ProviderError(this.name, 'network_error', 'Telegram Bot API request failed', true)
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ProviderError(this.name, 'redirect_rejected', 'Unexpected Telegram redirect', false)
    }

    const maxBytes = 500_000
    const declaredLength = Number(response.headers.get('content-length') ?? 0)
    if (declaredLength > maxBytes) {
      throw new ProviderError(this.name, 'response_too_large', 'Telegram response is too large', false)
    }
    const body = await response.arrayBuffer()
    if (body.byteLength > maxBytes) {
      throw new ProviderError(this.name, 'response_too_large', 'Telegram response is too large', false)
    }

    let data: TelegramApiResponse<T>
    try {
      data = JSON.parse(new TextDecoder().decode(body)) as TelegramApiResponse<T>
    } catch {
      throw new ProviderError(this.name, 'invalid_response', 'Telegram returned invalid JSON', response.status >= 500)
    }

    if (!response.ok || data.ok !== true || data.result === undefined) {
      const errorCode = data.error_code ?? response.status
      const retryAfterMs = data.parameters?.retry_after
        ? Math.min(3_600_000, Math.max(1_000, data.parameters.retry_after * 1_000))
        : undefined
      throw new ProviderError(
        this.name,
        `api_${errorCode}`,
        'Telegram Bot API rejected the request',
        errorCode === 429 || errorCode >= 500,
        retryAfterMs,
      )
    }

    return data.result
  }

  async acknowledgeInteraction(interactionId: string) {
    if (!interactionId) return
    await this.call<boolean>('answerCallbackQuery', { callback_query_id: interactionId })
  }

  async sendText(to: string, text: string) {
    if (!/^[1-9]\d{0,19}$/.test(to)) {
      throw new ProviderError(this.name, 'invalid_chat_id', 'Telegram chat ID is invalid', false)
    }
    if (!text || text.length > 4_096) {
      throw new ProviderError(this.name, 'invalid_message', 'Telegram message length is invalid', false)
    }
    const message = await this.call<{ message_id?: number; chat?: { id?: number } }>('sendMessage', {
      chat_id: to,
      text,
    })
    if (!Number.isSafeInteger(message.message_id)) {
      throw new ProviderError(this.name, 'invalid_response', 'Telegram response has no message ID', false)
    }
    return { providerMessageId: String(message.message_id) }
  }
}
