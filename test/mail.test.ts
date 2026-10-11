import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../src/config.js'
import { sendFeedbackMail } from '../src/mail/smtp.js'

// The notification is a courtesy on top of the database write, so the one thing that MUST hold
// is that it never gets in the way: no SMTP host → inert, and a call is still safe.
describe('feedback mail', () => {
  it('is disabled until every piece of configuration is present', () => {
    const keep = { ...process.env }
    try {
      delete process.env.SMTP_HOST
      delete process.env.FEEDBACK_MAIL_FROM
      delete process.env.FEEDBACK_MAIL_TO
      assert.equal(config.mail.enabled, false)

      process.env.SMTP_HOST = 'smtp.example.com'
      assert.equal(config.mail.enabled, false, 'a host alone is not enough')

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
      delete process.env.SMTP_HOST
      await sendFeedbackMail({
        feedbackId: 'x', createdAt: 'now', userId: null, appVersion: '1',
        route: '/', message: 'hi', hasAttachment: false,
      })
    } finally {
      process.env = keep
    }
  })
})
