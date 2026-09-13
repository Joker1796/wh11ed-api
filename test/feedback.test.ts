import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeedback, FeedbackPayloadError } from '../src/domain/feedback.js'
import { config } from '../src/config.js'

describe('feedback payload', () => {
  it('accepts a plain report and denormalizes version/route from the context', () => {
    const fb = parseFeedback({
      message: 'The button does nothing',
      context: { appVersion: '2.4.0', route: '/tracker/game', ua: 'x' },
    })
    assert.equal(fb.isSpam, false)
    assert.equal(fb.appVersion, '2.4.0')
    assert.equal(fb.route, '/tracker/game')
    assert.ok(fb.contextJson?.includes('"ua":"x"'))
    assert.equal(fb.attachmentJson, null)
  })

  it('flags a filled honeypot as spam without throwing', () => {
    const fb = parseFeedback({ message: 'buy now', website: 'http://spam' })
    assert.equal(fb.isSpam, true)
  })

  it('rejects an empty or missing message', () => {
    assert.throws(() => parseFeedback({ message: '' }))
    assert.throws(() => parseFeedback({}))
  })

  it('enforces the three byte caps', () => {
    assert.throws(
      () => parseFeedback({ message: 'x'.repeat(config.maxFeedbackMessageBytes + 1) }),
      FeedbackPayloadError,
    )
    assert.throws(
      () => parseFeedback({ message: 'ok', context: { blob: 'x'.repeat(config.maxFeedbackContextBytes) } }),
      FeedbackPayloadError,
    )
    assert.throws(
      () => parseFeedback({ message: 'ok', attachment: { blob: 'x'.repeat(config.maxFeedbackAttachmentBytes) } }),
      FeedbackPayloadError,
    )
  })

  it('keeps a non-string context version/route out of the denormalized columns', () => {
    const fb = parseFeedback({ message: 'ok', context: { appVersion: 42, route: {} } })
    assert.equal(fb.appVersion, null)
    assert.equal(fb.route, null)
  })
})
