import { z } from 'zod'
import { describe } from './registry.js'

// /health and /health/mail — app.ts. No account needed.

const tags = ['Health']

describe({
  method: 'get',
  path: '/health',
  tags,
  summary: 'Is the API up — touches no database',
  responses: { 200: { description: 'Up', schema: z.object({ status: z.literal('ok') }) } },
})

const mailHealth = z.object({
  status: z.enum(['ok', 'failing', 'disabled']),
  // ISO time of the last delivery / refusal, '' while there has been none.
  lastOkAt: z.string(),
  lastFailAt: z.string(),
  consecutiveFailures: z.number(),
})

describe({
  method: 'get',
  path: '/health/mail',
  tags,
  summary: 'Is mail getting out — the uptime check watches this',
  responses: {
    200: { description: 'The relay works', schema: mailHealth },
    503: { description: 'The relay keeps refusing, or mail is not configured', schema: mailHealth },
  },
})
