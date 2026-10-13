import type { Hono } from 'hono'
import { matchedRoutes } from 'hono/route'
import { swaggerUI } from '@hono/swagger-ui'
import { buildOpenApiDocument } from './index.js'
import { responseSchemas } from './registry.js'

// /openapi.json and /swagger on the stand. app.ts calls this only with SWAGGER=1, and only the
// docker stand sets it (docker-compose.yml).
//
// It also watches the stand's real traffic: a JSON answer whose route and status have no
// description, or which does not match the one it has, is a line in the API's log
// (`npm run stand:logs`). The answer itself goes out untouched — this is a tripwire for the
// description, not a check on the player.
export function mountApiDocs(app: Hono) {
  app.use('*', async (c, next) => {
    await next()
    if (!(c.res.headers.get('content-type') || '').includes('application/json')) return
    const route = matchedRoutes(c).filter((r) => r.method !== 'ALL').at(-1)
    if (!route || route.path === '/openapi.json') return
    const key = `${c.req.method} ${route.path.replace(/:(\w+)/g, '{$1}')} ${c.res.status}`
    const schema = responseSchemas.get(key)
    if (!schema) {
      console.warn(`[openapi] no description for ${key}`)
      return
    }
    const answer = await c.res.clone().json().catch(() => undefined)
    const checked = schema.safeParse(answer)
    if (!checked.success) {
      console.warn(`[openapi] ${key} does not match its description:`, checked.error.issues.slice(0, 3))
    }
  })

  const doc = buildOpenApiDocument()
  app.get('/openapi.json', (c) => c.json(doc))
  app.get('/swagger', swaggerUI({ url: '/openapi.json', persistAuthorization: true }))
}
