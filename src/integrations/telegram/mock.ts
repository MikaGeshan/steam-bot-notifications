import type { MessagingProvider, ParsedMessagingWebhook } from '../../ports'

export class MockMessagingProvider implements MessagingProvider {
  readonly name = 'mock-telegram'
  readonly sent: Array<{ to: string; text: string; providerMessageId: string }> = []

  async verifyWebhook() {
    return true
  }

  parseWebhook(payload: unknown): ParsedMessagingWebhook {
    if (!payload || typeof payload !== 'object') return { messages: [] }
    const candidate = payload as Partial<ParsedMessagingWebhook>
    return { messages: candidate.messages ?? [] }
  }

  async acknowledgeInteraction() {}

  async sendText(to: string, text: string) {
    const providerMessageId = `mock-${crypto.randomUUID()}`
    this.sent.push({ to, text, providerMessageId })
    return { providerMessageId }
  }
}
