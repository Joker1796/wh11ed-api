import { Hono } from 'hono'
import { requireAuth, type AuthVars } from '../auth/middleware.js'
import { getUser } from '../db/users.repo.js'
import { getLoginByUser } from '../db/password.repo.js'

export const meRoutes = new Hono<{ Variables: AuthVars }>()

meRoutes.use('*', requireAuth)

meRoutes.get('/', async (c) => {
  const user = await getUser(c.var.userId)
  if (!user) return c.json({ error: 'not_found' }, 404)
  // `login`: the account's email + password sign-in, if it has one — the SPA asks the player to
  // confirm the address until `verified` is true.
  const login = await getLoginByUser(user.user_id)
  return c.json({
    id: user.user_id,
    email: user.email || null,
    displayName: user.display_name || null,
    login: login ? { email: login.email, verified: !!login.verified_at } : null,
  })
})
