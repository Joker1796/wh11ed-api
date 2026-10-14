import { db } from './driver.js'

// Aggregates of the errors visitors sent (domain/clientErrors.ts, migrations/003_client_errors.sql).
// Production and the beta are two tables of one shape; `channel` picks one, and only these two
// names ever reach the identifier below.
export type Channel = 'prod' | 'beta'
const TABLE: Record<Channel, string> = { prod: 'client_errors', beta: 'client_errors_beta' }
const MAX_ROUTES = 20

export interface ErrorHit {
  fingerprint: string
  appVersion: string
  kind: string
  message: string
  sample: Record<string, unknown>
  browser: string
  route: string
  at: string
}

/** One more occurrence: a new row, or the existing one counted up. */
export async function recordError(channel: Channel, h: ErrorHit): Promise<void> {
  const sql = db()
  const t = sql(TABLE[channel])
  const route = h.route || '(none)'
  await sql`
    INSERT INTO ${t} AS e (fingerprint, app_version, kind, message, first_seen, last_seen, count, sample, browsers, routes)
    VALUES (${h.fingerprint}, ${h.appVersion}, ${h.kind}, ${h.message}, ${h.at}, ${h.at}, 1, ${sql.json(h.sample as never)},
            ${sql.json({ [h.browser]: 1 })}, ${sql.json({ [route]: 1 })})
    ON CONFLICT (fingerprint, app_version) DO UPDATE SET
      count = e.count + 1,
      last_seen = EXCLUDED.last_seen,
      sample = EXCLUDED.sample,
      browsers = e.browsers || jsonb_build_object(${h.browser}::text, COALESCE((e.browsers->>${h.browser})::int, 0) + 1),
      routes = CASE
        WHEN e.routes ? ${route} OR (SELECT count(*) FROM jsonb_object_keys(e.routes)) < ${MAX_ROUTES}
        THEN e.routes || jsonb_build_object(${route}::text, COALESCE((e.routes->>${route})::int, 0) + 1)
        ELSE e.routes END`
}

/** A reporting browser's daily hello: the denominator of the digest. */
export async function countReporter(channel: Channel, day: string): Promise<void> {
  await db()`
    INSERT INTO client_error_reporters (day, channel, sessions) VALUES (${day}, ${channel}, 1)
    ON CONFLICT (day, channel) DO UPDATE SET sessions = client_error_reporters.sessions + 1`
}

export interface ErrorRow {
  fingerprint: string
  app_version: string
  kind: string
  message: string
  first_seen: Date
  last_seen: Date
  count: number
  sample: Record<string, unknown>
  browsers: Record<string, number>
  routes: Record<string, number>
  resolved_in: string | null
  alerted_at: Date | null
}

/** Every row seen since `since`, newest first. */
export async function listErrors(channel: Channel, since: Date): Promise<ErrorRow[]> {
  const sql = db()
  return sql<ErrorRow[]>`SELECT * FROM ${sql(TABLE[channel])} WHERE last_seen >= ${since} ORDER BY last_seen DESC`
}

/** The rows of one error (all its versions), by fingerprint prefix. */
export async function errorsByPrefix(channel: Channel, prefix: string): Promise<ErrorRow[]> {
  const sql = db()
  return sql<ErrorRow[]>`SELECT * FROM ${sql(TABLE[channel])} WHERE fingerprint LIKE ${prefix + '%'} ORDER BY app_version DESC`
}

/** Mark an error fixed as of a version; it is "open" again if a later version sends it. */
export async function resolveErrors(channel: Channel, fingerprint: string, version: string): Promise<number> {
  const sql = db()
  const rows = await sql`UPDATE ${sql(TABLE[channel])} SET resolved_in = ${version} WHERE fingerprint = ${fingerprint} RETURNING 1`
  return rows.length
}

export async function markAlerted(channel: Channel, fingerprint: string, version: string, at: Date): Promise<void> {
  const sql = db()
  await sql`UPDATE ${sql(TABLE[channel])} SET alerted_at = ${at} WHERE fingerprint = ${fingerprint} AND app_version = ${version}`
}

/** The fingerprints any OLDER row carries — an error that existed before a release is not news. */
export async function fingerprintsBefore(channel: Channel, version: string): Promise<Set<string>> {
  const sql = db()
  const rows = await sql<{ fingerprint: string }[]>`SELECT DISTINCT fingerprint FROM ${sql(TABLE[channel])} WHERE app_version <> ${version}`
  return new Set(rows.map((r) => r.fingerprint))
}

/** When a version was first seen at all — the release time, as the error table knows it. */
export async function versionStart(channel: Channel, version: string): Promise<Date | null> {
  const sql = db()
  const [r] = await sql<{ t: Date | null }[]>`SELECT min(first_seen) AS t FROM ${sql(TABLE[channel])} WHERE app_version = ${version}`
  return r?.t ?? null
}

export async function reporters(channel: Channel, day: string): Promise<number> {
  const [r] = await db()<{ sessions: number }[]>`SELECT sessions FROM client_error_reporters WHERE day = ${day} AND channel = ${channel}`
  return r?.sessions ?? 0
}

/** Rows quiet for longer than `days` go (owner: 30 days). */
export async function purgeErrors(days: number): Promise<number> {
  const sql = db()
  let n = 0
  for (const t of Object.values(TABLE)) n += (await sql`DELETE FROM ${sql(t)} WHERE last_seen < now() - make_interval(days => ${days}) RETURNING 1`).length
  await sql`DELETE FROM client_error_reporters WHERE day < (now() - make_interval(days => ${days}))::date`
  return n
}
