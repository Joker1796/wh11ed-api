import { sign } from 'hono/jwt'
import { config } from '../src/config.js'

// A week-long access token for the LOCAL stand, signed with this .env's key — what the frontend's
// dev mock sends when it forwards /party calls to a real local backend (useAuth.js, DEV only).
// Paste it into localStorage['wh11ed-dev-jwt'] in the host tab. Meaningless against production:
// the key differs.
const now = Math.floor(Date.now() / 1000)
const token = await sign({ sub: process.argv[2] || 'dev-host', iat: now, exp: now + 7 * 86_400 }, config.jwtSigningKey, 'HS256')
console.log(token)
