import { describe, expect, test } from 'bun:test'
import { TelegramBotProvider } from '../../src/integrations/telegram/bot-api'
import { ProviderError } from '../../src/integrations/http'

const provider = new TelegramBotProvider({
  botToken: 'test-token',
  webhookSecret: 'test-secret',
})

describe('Telegram Bot API adapter', () => {
  test('verifies the webhook secret exactly', async () => {
    expect(await provider.verifyWebhook('test-secret')).toBe(true)
    expect(await provider.verifyWebhook('test-secret ')).toBe(false)
    expect(await provider.verifyWebhook('wrong')).toBe(false)
    expect(await provider.verifyWebhook(null)).toBe(false)
  })

  test('parses a private text message using update_id as event ID', () => {
    const parsed = provider.parseWebhook({
      update_id: 1001,
      message: {
        message_id: 7,
        date: 1789459200,
        chat: { id: 123456789012, type: 'private' },
        from: { id: 123456789012, is_bot: false },
        text: ' /diskon Hades ',
      },
    })
    expect(parsed.messages).toEqual([{
      eventId: '1001',
      address: '123456789012',
      text: '/diskon Hades',
      timestamp: '2026-09-15T08:00:00.000Z',
    }])
  })

  test('parses callback data and keeps its acknowledgement ID', () => {
    const parsed = provider.parseWebhook({
      update_id: 1002,
      callback_query: {
        id: 'callback-1',
        from: { id: 123456789012, is_bot: false },
        data: '/wishlist',
        message: {
          message_id: 8,
          date: 1789459201,
          chat: { id: 123456789012, type: 'private' },
          from: { id: 777000, is_bot: true },
        },
      },
    })
    expect(parsed.messages[0]).toMatchObject({
      eventId: '1002',
      address: '123456789012',
      text: '/wishlist',
      interactionId: 'callback-1',
    })
  })

  test('ignores group messages and rejects malformed update IDs', () => {
    expect(provider.parseWebhook({
      update_id: 1003,
      message: {
        chat: { id: -100123, type: 'supergroup' },
        from: { id: 1, is_bot: false },
        text: '/diskon Hades',
      },
    }).messages).toHaveLength(0)
    expect(() => provider.parseWebhook({ message: {} })).toThrow('update_id')
  })

  test('sends plain text without returning the chat ID as message metadata', async () => {
    const calls: Array<{ url: string; body: unknown }> = []
    const telegram = new TelegramBotProvider({
      botToken: 'test-token',
      webhookSecret: 'test-secret',
    }, (async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) })
      return Response.json({
        ok: true,
        result: { message_id: 42, chat: { id: 123456789012 } },
      })
    }))

    expect(await telegram.sendText('123456789012', 'Halo')).toEqual({
      providerMessageId: '42',
    })
    expect(calls[0]?.url.endsWith('/sendMessage')).toBe(true)
    expect(calls[0]?.body).toEqual({ chat_id: '123456789012', text: 'Halo' })
  })

  test('exposes Telegram retry_after without leaking response details', async () => {
    const telegram = new TelegramBotProvider({
      botToken: 'test-token',
      webhookSecret: 'test-secret',
    }, (async () => Response.json({
      ok: false,
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 12 },
    }, { status: 429 })))

    try {
      await telegram.sendText('123456789012', 'Halo')
      throw new Error('Expected Telegram provider to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).retryable).toBe(true)
      expect((error as ProviderError).retryAfterMs).toBe(12_000)
      expect((error as Error).message).not.toContain('test-token')
    }
  })
})
