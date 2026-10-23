import { createHash } from 'node:crypto'
import { z } from 'zod'

// Errors the site's visitors ran into, sent by the ones who switched sending on (POST /errors,
// routes/clientErrors.ts). The site batches what it saw and sends it once; we keep aggregates, one
// row per error per site version (db/clientErrors.repo.ts). Nothing here identifies a person: no IP
// and no account is stored, the route loses its query and hash (a shared roster rides in the hash),
// and the user agent is read only to count a browser family.

export const MAX_ERRORS = 10
export const MAX_BODY_BYTES = 16 * 1024

const VERSION = /^\d+\.\d+\.\d+$/

export const clientErrorSchema = z.object({
  kind: z.enum(['error', 'rejection', 'chunk']),
  msg: z.string().min(1).max(500),
  stack: z.string().max(2000).optional(),
  src: z.string().max(300).optional(),
})

export const clientErrorsSchema = z.object({
  channel: z.enum(['prod', 'beta']),
  appVersion: z.string().regex(VERSION),
  dataVersion: z.number().int().nonnegative().optional(),
  locale: z.enum(['en', 'ru']).optional(),
  standalone: z.boolean().optional(),
  route: z.string().max(300).optional(),
  // Once a day a reporting browser says so, with or without errors: the day's reporter count.
  hello: z.boolean().optional(),
  // Sites up to 2.10.3 also sent `perf` and `device` (screen timings, dropped by the owner on
  // 2026-10-23): unknown keys, stripped here like any other.
  errors: z.array(clientErrorSchema).max(MAX_ERRORS).default([]),
})

export type ClientErrorsPayload = z.infer<typeof clientErrorsSchema>
export class ClientErrorsTooLarge extends Error {}

export function parseClientErrors(text: string): ClientErrorsPayload {
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new ClientErrorsTooLarge()
  return clientErrorsSchema.parse(JSON.parse(text))
}

// The same error must land in the same row however the build names its files and wherever the
// numbers in its message fall: a chunk's hash (`RosterEditorView-BJ-1xCnO.js`), a line and column,
// an id, a count. What is left is the kind, the shape of the message and the function and file of
// the first frame of the stack.
export function normalizeMessage(msg: string): string {
  return msg
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** The first frame of a stack, without the chunk's hash, the origin or the line and column. */
export function topFrame(stack?: string): string {
  if (!stack) return ''
  for (const line of stack.split('\n')) {
    // Chrome: "    at fn (https://x/assets/a-HASH.js:1:2)"; Firefox/Safari: "fn@https://x/assets/a-HASH.js:1:2"
    const m = line.match(/(?:at\s+([^\s(]+)\s+\(|at\s+\(?|^([^@\s]*)@)([^)\s]+?):\d+:\d+\)?\s*$/)
    if (!m) continue
    const fn = m[1] || m[2] || ''
    const file = ((m[3] || '').split('/').pop() || '').replace(/-[A-Za-z0-9_-]{6,}(\.m?js)$/, '$1')
    return `${fn}@${file}`
  }
  return ''
}

export function fingerprint(e: { kind: string; msg: string; stack?: string }): string {
  return createHash('sha256').update(`${e.kind}|${normalizeMessage(e.msg)}|${topFrame(e.stack)}`).digest('hex').slice(0, 16)
}

/** A route as a place, not an address: no query or hash, ids folded, and no `/ru` — the locale is
 * stored beside it, and one page in two languages is one place. */
export function normalizeRoute(route?: string): string {
  if (!route) return ''
  return ((route.split(/[?#]/)[0] || '').replace(/^\/ru(?=\/|$)/, '') || '/')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .slice(0, 120)
}

/** A browser family and system, for a count — never the user agent itself. */
export function browserOf(ua?: string): string {
  if (!ua) return 'unknown'
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'other'
  const br = /YaBrowser/.test(ua) ? 'Yandex' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Edg\//.test(ua) ? 'Edge'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /OPR\//.test(ua) ? 'Opera' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'other'
  return `${br} ${os}`
}

/** Site versions compared as numbers: 2.10.0 is after 2.9.1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** Open = never marked fixed, or sent again by a version after the fix. */
export const isOpen = (r: { app_version: string; resolved_in: string | null }) =>
  !r.resolved_in || compareVersions(r.app_version, r.resolved_in) > 0
