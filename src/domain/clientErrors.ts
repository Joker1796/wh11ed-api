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

// A screen's performance over one page session (migrations/004_client_perf.sql): its route
// pattern, the slowest tap-to-paint, the long tasks, the visible seconds. Sent with the errors, by
// the same browsers, at most MAX_PERF screens a batch.
export const MAX_PERF = 8
export const INP_BUCKETS = [100, 200, 500, 1000] as const
export const clientPerfSchema = z.object({
  route: z.string().min(1).max(120).regex(/^\/[\w:/().|-]*$/),
  inp: z.number().int().min(0).max(60000).optional(),
  longN: z.number().int().min(0).max(100000),
  longMs: z.number().int().min(0).max(86400000),
  secs: z.number().int().min(0).max(86400),
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
  errors: z.array(clientErrorSchema).max(MAX_ERRORS).default([]),
  perf: z.array(clientPerfSchema).max(MAX_PERF).default([]),
  // Logical cores and device memory, coarse ("c8m4"): what tells a weak phone from a strong one.
  device: z.string().regex(/^c\d{1,2}m\d{0,2}(\.\d{1,2})?$/).optional(),
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

/** A route as a place, not an address: no query or hash, ids folded. */
export function normalizeRoute(route?: string): string {
  if (!route) return ''
  return (route.split(/[?#]/)[0] || '')
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

/** Which INP bucket (migrations/004_client_perf.sql) a session's slowest tap falls in. */
export function inpBucket(ms: number): number {
  const i = INP_BUCKETS.findIndex((b) => ms < b)
  return i === -1 ? INP_BUCKETS.length : i
}

/** The p75 of a bucketed histogram, as the bucket's upper edge ("<200 ms"); null with no sessions. */
export function p75Bucket(hist: number[]): string | null {
  const total = hist.reduce((s, n) => s + n, 0)
  if (!total) return null
  let seen = 0
  for (let i = 0; i < hist.length; i++) {
    seen += hist[i] ?? 0
    if (seen >= total * 0.75) return i < INP_BUCKETS.length ? `<${INP_BUCKETS[i]}` : `≥${INP_BUCKETS[INP_BUCKETS.length - 1]}`
  }
  return null
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
