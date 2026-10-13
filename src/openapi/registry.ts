import { z } from 'zod'
import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi'

// The stand's API description — what /openapi.json serves and /swagger draws. STAND ONLY: this
// directory imports devDependencies, which the production image does not install, and nothing
// outside it imports it except app.ts behind SWAGGER=1 (see mount.ts).
//
// The description is built from the SAME zod schemas the routes validate with — they are exported
// from routes/* and domain/* and read here, never restated — so a changed check is a changed
// description. What the routes return has schemas too, in domain/*, and the repos' return types
// are inferred from them: a response drifting from its description fails `npm run typecheck`.
// test/openapi.test.ts fails on a route the description does not list.

extendZodWithOpenApi(z)

export const registry = new OpenAPIRegistry()

export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'An access token. On the stand: GET /dev/jwt, then paste its `token` into Authorize.',
})

// Every refusal is `{ "error": "<code>" }`; the codes a route can answer with are listed on it.
export const errorBody = (...codes: [string, ...string[]]) => ({
  content: { 'application/json': { schema: z.object({ error: z.enum(codes) }) } },
})

export const json = (schema: z.ZodTypeAny) => ({ content: { 'application/json': { schema } } })
