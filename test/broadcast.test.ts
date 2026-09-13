import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  newBroadcastToken,
  broadcastTokenSchema,
  parseBroadcastPayload,
  broadcastExpiry,
  BroadcastPayloadError,
} from '../src/domain/broadcast.js'
import { config } from '../src/config.js'

describe('broadcast tokens', () => {
  it('generates URL-safe tokens that pass their own schema', () => {
    for (let i = 0; i < 20; i++) {
      const t = newBroadcastToken()
      assert.equal(broadcastTokenSchema.safeParse(t).success, true)
      assert.match(t, /^[A-Za-z0-9_-]+$/)
    }
  })

  it('two tokens differ', () => {
    assert.notEqual(newBroadcastToken(), newBroadcastToken())
  })

  it('rejects malformed tokens', () => {
    for (const bad of ['', 'short', 'has spaces here yes', 'x'.repeat(65), 'п'.repeat(20)]) {
      assert.equal(broadcastTokenSchema.safeParse(bad).success, false)
    }
  })
})

describe('broadcast payload', () => {
  it('accepts an object and returns canonical JSON', () => {
    const { json } = parseBroadcastPayload({ v: 1, sides: [] })
    assert.equal(json, '{"v":1,"sides":[]}')
  })

  it('rejects non-objects', () => {
    for (const bad of [null, 'str', 42, [1, 2]]) {
      assert.throws(() => parseBroadcastPayload(bad))
    }
  })

  it('enforces the byte cap', () => {
    const big = { blob: 'x'.repeat(config.maxBroadcastBytes) }
    assert.throws(() => parseBroadcastPayload(big), BroadcastPayloadError)
  })
})

describe('broadcast expiry', () => {
  it('is the configured number of days ahead', () => {
    const now = Date.UTC(2026, 0, 1)
    const exp = broadcastExpiry(now)
    assert.equal(exp.getTime() - now, config.broadcastTtlDays * 24 * 60 * 60 * 1000)
  })
})
