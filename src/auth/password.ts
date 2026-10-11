import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

// Password hashing with the scrypt Node ships — no native dependency to build on the server.
// N=2^15, r=8, p=1: ~32 MB and ~0.1 s per hash, the OWASP-recommended floor for scrypt. The
// parameters are stored with the hash, so raising them later only needs a re-hash on next login.
const N = 32768
const R = 8
const P = 1
const KEYLEN = 64
const MAXMEM = 64 * 1024 * 1024

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: MAXMEM }
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, KEYLEN, opts, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, N, R, P)
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !n || !r || !p || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const key = await scrypt(password, Buffer.from(salt, 'base64'), Number(n), Number(r), Number(p))
  return key.length === expected.length && timingSafeEqual(key, expected)
}

// A login for an address that has no account still pays for one hash, so the response time does not
// tell a stranger which addresses are registered.
let dummy: Promise<string> | null = null
export async function burnHashTime(password: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password')
  await verifyPassword(password, await dummy)
}

export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}
