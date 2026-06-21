import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { getUser } from '../db/users.repo.js'

export const meRoutes = new Hono<{ Variables: AuthVars }>()

meRoutes.use('*', requireAuth)

meRoutes.get('/', async (c) => {
  const user = await getUser(c.var.userId)
  if (!user) return c.json({ error: 'not_found' }, 404)
  return c.json({
    id: user.user_id,
    email: user.email || null,
    displayName: user.display_name || null,
  })
})
