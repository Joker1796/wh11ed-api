import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../src/config.js'
import { sendFeedbackMail } from '../src/mail/postbox.js'

// The notification is a courtesy on top of the database write, so the one thing that MUST hold
// is that it never gets in the way: no credentials → inert, and a call is still safe.
describe('feedback mail', () => {
  it('is disabled until every piece of configuration is present', () => {
    const keep = { ...process.env }
    try {
      delete process.env.POSTBOX_KEY_ID
      delete process.env.POSTBOX_SECRET
      delete process.env.FEEDBACK_MAIL_FROM
      delete process.env.FEEDBACK_MAIL_TO
      assert.equal(config.mail.enabled, false)

      process.env.POSTBOX_KEY_ID = 'id'
      process.env.POSTBOX_SECRET = 'secret'
      assert.equal(config.mail.enabled, false, 'credentials alone are not enough')

      process.env.FEEDBACK_MAIL_FROM = 'noreply@wh-rules.ru'
      process.env.FEEDBACK_MAIL_TO = 'someone@example.com'
      assert.equal(config.mail.enabled, true)
    } finally {
      process.env = keep
    }
  })

  it('sends nothing, and throws nothing, when disabled', async () => {
    const keep = { ...process.env }
    try {
      delete process.env.POSTBOX_KEY_ID
      await sendFeedbackMail({
        feedbackId: 'x', createdAt: 'now', userId: null, appVersion: '1',
        route: '/', message: 'hi', hasAttachment: false,
      })
    } finally {
      process.env = keep
    }
  })
})
