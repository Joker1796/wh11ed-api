import { createMiddleware } from 'hono/factory'
import { verifyAccessToken } from './jwt.js'

export interface AuthVars {
  userId: string
}

// Requires a valid Bearer access token; populates c.var.userId. 401 otherwise.
export const requireAuth = createMiddleware<{ Variables: AuthVars }>(async (c, next) => {
  const header = c.req.header('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return c.json({ error: 'missing_bearer_token' }, 401)
  const claims = await verifyAccessToken(match[1]!)
  if (!claims) return c.json({ error: 'invalid_token' }, 401)
  c.set('userId', claims.sub)
  await next()
})
