import { Hono } from 'hono'
import { fromStored, isVersion, pageLimit, versionRank } from '../domain/changelog.js'
import { listChangelog } from '../db/changelog.repo.js'

// The archive of release notes (see domain/changelog.ts). Public and read-only: the notes are
// published, anyone can read them on the site. Nothing here writes — `npm run changelog:publish`
// does, with YDB credentials.
export const changelogRoutes = new Hono()

// A page changes only when a deploy moves more notes in, and those land BELOW every page already
// served: a cached page stays exactly right. An hour keeps a reader paging back and forth off the
// gateway's rate limit; the notes are not worth a longer promise.
const CACHE = 'public, max-age=3600'

// GET /changelog?before=2.6.0&limit=10 → { entries: [...newest first], more: boolean }
// `before` omitted = from the newest archived entry.
changelogRoutes.get('/', async (c) => {
  const before = c.req.query('before')
  if (before != null && before !== '' && !isVersion(before)) return c.json({ error: 'bad_before' }, 400)
  const limit = pageLimit(c.req.query('limit'))
  if (limit == null) return c.json({ error: 'bad_limit' }, 400)

  const rows = await listChangelog(before ? versionRank(before) : null, limit)
  const more = rows.length > limit
  c.header('Cache-Control', CACHE)
  return c.json({ entries: rows.slice(0, limit).map(fromStored), more })
})
