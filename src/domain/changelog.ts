import { z } from 'zod'

// The frontend's "What's new" page, older part. The recent releases ship with the app itself
// (wh11ed `src/data/changelog.js`); everything older is moved here at deploy time and read back
// page by page, only by the reader who asks for it — so notes almost nobody reads stay out of the
// app's first load and out of the installed app's offline download (owner's call, 2026-09-27).
//
// An entry is exactly what the frontend file holds: a version, a date, and two parallel note lists
// (EN/RU) where each item is a bullet string or a `{ h }` section heading. The frontend owns the
// wording; this validates only shape, parity and size. Written ONLY by `npm run changelog:publish`
// (YDB credentials, not HTTP); served by the public GET in routes/changelog.ts.

const SEMVER = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const noteSchema = z.union([z.string().min(1), z.object({ h: z.string().min(1) }).strict()])

export const changelogEntrySchema = z
  .object({
    version: z.string().regex(SEMVER),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    en: z.array(noteSchema).min(1),
    ru: z.array(noteSchema).min(1),
  })
  .strict()
  // The frontend renders the two locales from the same positions: a heading at i in one is a
  // heading at i in the other (its own changelog test enforces the same on the file).
  .refine(
    (e) => e.en.length === e.ru.length && e.en.every((n, i) => typeof n === typeof e.ru[i]),
    { message: 'en and ru are not parallel' },
  )

export type ChangelogNote = z.infer<typeof noteSchema>
export type ChangelogEntry = z.infer<typeof changelogEntrySchema>

// One entry is a few KB; this is a fence against a malformed publish, not a quota.
export const MAX_ENTRY_BYTES = 64 * 1024

// Versions order numerically (2.10.0 after 2.9.9), so the table is keyed by a number built from
// them: three components of up to three digits each fit a Uint32 with room to spare.
export function versionRank(version: string): number {
  const m = SEMVER.exec(version)
  if (!m) throw new Error(`not a version: ${version}`)
  return Number(m[1]) * 1_000_000 + Number(m[2]) * 1_000 + Number(m[3])
}

export function isVersion(v: string): boolean {
  return SEMVER.test(v)
}

// A page of the archive: at most `limit` entries strictly older than `before` (newest first).
export const PAGE_DEFAULT = 10
export const PAGE_MAX = 20

export function pageLimit(raw: string | undefined): number | null {
  if (raw == null || raw === '') return PAGE_DEFAULT
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return n >= 1 && n <= PAGE_MAX ? n : null
}

// What a publish hands the repo: the entry as stored, validated and serialised once.
export interface StoredEntry {
  rank: number
  version: string
  date: string
  en: string
  ru: string
}

export class ChangelogEntryError extends Error {}

export function toStored(raw: unknown): StoredEntry {
  const parsed = changelogEntrySchema.safeParse(raw)
  if (!parsed.success) {
    const v = (raw as { version?: unknown })?.version
    throw new ChangelogEntryError(`entry ${typeof v === 'string' ? v : '?'}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  const e = parsed.data
  const stored = { rank: versionRank(e.version), version: e.version, date: e.date, en: JSON.stringify(e.en), ru: JSON.stringify(e.ru) }
  if (stored.en.length + stored.ru.length > MAX_ENTRY_BYTES) throw new ChangelogEntryError(`entry ${e.version}: larger than ${MAX_ENTRY_BYTES} bytes`)
  return stored
}

export function fromStored(row: { version: string; date: string | null; en: string | null; ru: string | null }): ChangelogEntry {
  return { version: row.version, date: row.date ?? '', en: JSON.parse(row.en ?? '[]'), ru: JSON.parse(row.ru ?? '[]') }
}
