import { describe, expect, test } from 'bun:test'
import {
  createCipher,
  hmacSha256,
  timingSafeEqualHex,
  timingSafeEqualString,
} from '../../src/lib/crypto'

describe('crypto helpers', () => {
  test('encrypts with random IV and decrypts the original address', async () => {
    const cipher = createCipher('test-only-secret')
    const first = await cipher.encrypt('628111111111')
    const second = await cipher.encrypt('628111111111')
    expect(first).not.toBe(second)
    expect(await cipher.decrypt(first)).toBe('628111111111')
  })

  test('compares signatures without throwing on malformed length', async () => {
    const signature = await hmacSha256('secret', 'body')
    expect(timingSafeEqualHex(signature, signature)).toBe(true)
    expect(timingSafeEqualHex(signature, 'aa')).toBe(false)
    expect(timingSafeEqualHex(signature, 'not-hex')).toBe(false)
    expect(timingSafeEqualString('token', 'token')).toBe(true)
    expect(timingSafeEqualString('token', 'x')).toBe(false)
  })
})
