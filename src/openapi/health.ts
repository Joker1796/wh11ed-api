import { z } from 'zod'
import { json, registry } from './registry.js'

// /health and /health/mail — app.ts. No account needed.

const tag = 'Health'

registry.registerPath({
  method: 'get',
  path: '/health',
  tags: [tag],
  summary: 'Is the API up — touches no database',
  responses: { 200: { description: 'Up', ...json(z.object({ status: z.literal('ok') })) } },
})

const mailHealth = z.object({
  status: z.enum(['ok', 'failing', 'disabled']),
  // ISO time of the last delivery / refusal, '' while there has been none.
  lastOkAt: z.string(),
  lastFailAt: z.string(),
  consecutiveFailures: z.number(),
})

registry.registerPath({
  method: 'get',
  path: '/health/mail',
  tags: [tag],
  summary: 'Is mail getting out — the uptime check watches this',
  responses: {
    200: { description: 'The relay works', ...json(mailHealth) },
    503: { description: 'The relay keeps refusing, or mail is not configured', ...json(mailHealth) },
  },
})
