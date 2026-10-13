import type { Hono } from 'hono'
import { swaggerUI } from '@hono/swagger-ui'
import { buildOpenApiDocument } from './index.js'

// /openapi.json and /swagger on the stand. app.ts calls this only with SWAGGER=1, and only the
// docker stand sets it (docker-compose.yml).
export function mountApiDocs(app: Hono) {
  const doc = buildOpenApiDocument()
  app.get('/openapi.json', (c) => c.json(doc))
  app.get('/swagger', swaggerUI({ url: '/openapi.json', persistAuthorization: true }))
}
