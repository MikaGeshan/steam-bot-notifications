const encoder = new TextEncoder()

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'))

async function deriveAesKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret))
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value))
  return toHex(new Uint8Array(digest))
}

export async function hmacSha256(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))))
}

export function timingSafeEqualHex(left: string, right: string) {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) return false
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}

export function timingSafeEqualString(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}

export function createCipher(secret: string) {
  return {
    async encrypt(value: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const key = await deriveAesKey(secret)
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(value),
      )
      return `${toBase64(iv)}.${toBase64(new Uint8Array(encrypted))}`
    },
    async decrypt(value: string) {
      const [ivPart, dataPart] = value.split('.')
      if (!ivPart || !dataPart) throw new Error('Invalid encrypted value')
      const key = await deriveAesKey(secret)
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64(ivPart) },
        key,
        fromBase64(dataPart),
      )
      return new TextDecoder().decode(decrypted)
    },
  }
}
