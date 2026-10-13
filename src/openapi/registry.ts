import { z } from 'zod'
import { extendZodWithOpenApi, OpenAPIRegistry, type RouteConfig } from '@asteasolutions/zod-to-openapi'

// The stand's API description — what /openapi.json serves and /swagger draws. STAND ONLY: this
// directory imports devDependencies, which the production image does not install, and nothing
// outside it imports it except app.ts behind SWAGGER=1 (see mount.ts).
//
// The description is built from the SAME zod schemas the routes validate with — they are exported
// from routes/* and domain/* and read here, never restated. What a route answers is described
// here too; where the answer has a type in domain/*, that type is inferred from the schema, and
// on the stand every JSON answer is checked against its description as it goes out (mount.ts).
// test/openapi.test.ts fails on a route the description does not list.
//
// What is NOT written here: the numbers behind the abuse fences (attempts per minute, how long a
// join code lives). The code is public and states them, but this page is a handbook, and a
// handbook of exact thresholds helps nobody but a guesser. A route says it can answer 429.

extendZodWithOpenApi(z)

export const registry = new OpenAPIRegistry()

export const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description: 'An account access token (POST /auth/refresh). On the stand: GET /dev/jwt, then paste its `token` here.',
})

export const memberAuth = registry.registerComponent('securitySchemes', 'memberToken', {
  type: 'http',
  scheme: 'bearer',
  description: 'A party member token — `memberToken` from POST /party, /party/join or /party/{id}/reclaim. Speaks for one phone in one party.',
})

export const refreshCookie = registry.registerComponent('securitySchemes', 'refreshCookie', {
  type: 'apiKey',
  in: 'cookie',
  name: 'rt',
  description: 'The HttpOnly session cookie set by a sign-in (path /auth). The browser sends it by itself.',
})

export const asAccount = [{ [bearerAuth.name]: [] }]
export const asMember = [{ [memberAuth.name]: [] }]

/** Every refusal is `{ "error": "<code>" }`; the codes a route can answer with are listed on it. */
export const errorSchema = (...codes: [string, ...string[]]) => z.object({ error: z.enum(codes) })

// The JSON answers each route is described with, by `METHOD /path STATUS` — what mount.ts checks
// the stand's real answers against.
export const responseSchemas = new Map<string, z.ZodTypeAny>()

type Answer = { description: string; schema?: z.ZodTypeAny; headers?: Record<string, { description: string; schema: { type: 'string' } }> }

/**
 * Describe one route. `responses` maps a status to what it means and, for a JSON answer, its
 * schema; a status with no schema has no JSON body (204, 304, a redirect).
 */
export function describe(spec: Omit<RouteConfig, 'responses'> & { responses: Record<number, string | Answer> }) {
  const responses: RouteConfig['responses'] = {}
  // Any route can meet the API-wide ceiling per address (lib/rate-limit.ts).
  for (const [status, a] of Object.entries({ ...tooMany, ...spec.responses })) {
    const answer = typeof a === 'string' ? { description: a } : a
    responses[status] = {
      description: answer.description,
      ...(answer.headers ? { headers: answer.headers } : {}),
      ...(answer.schema ? { content: { 'application/json': { schema: answer.schema } } } : {}),
    }
    if (answer.schema) responseSchemas.set(`${spec.method.toUpperCase()} ${spec.path} ${status}`, answer.schema)
  }
  registry.registerPath({ ...spec, responses })
}

/** A JSON request body. */
export const body = (schema: z.ZodTypeAny, required = true) => ({ required, content: { 'application/json': { schema } } })

// The answers most routes share.
export const tooMany: Record<number, Answer> = { 429: { description: 'Too many requests — try again later', schema: errorSchema('too_many') } }
export const unauthorized: Record<number, Answer> = {
  401: { description: 'No valid access token', schema: errorSchema('missing_bearer_token', 'invalid_token') },
}
export const forbiddenOrigin: Record<number, Answer> = {
  403: { description: 'A browser on a site that is not ours', schema: errorSchema('forbidden_origin') },
}
