import { sign, verify } from 'hono/jwt'
import { config } from '../config.js'

export interface AccessTokenClaims {
  sub: string // user_id
  exp: number
  iat: number
}

export async function issueAccessToken(userId: string): Promise<{ token: string; expiresIn: number }> {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + config.accessTokenTtl
  const token = await sign({ sub: userId, iat: now, exp }, config.jwtSigningKey, 'HS256')
  return { token, expiresIn: config.accessTokenTtl }
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const payload = (await verify(token, config.jwtSigningKey, 'HS256')) as unknown as AccessTokenClaims
    if (!payload?.sub) return null
    return payload
  } catch {
    return null
  }
}
