import { TypedValues } from 'ydb-sdk'
import { query, transaction } from './driver.js'
import type { PrefsScopeRow } from '../domain/prefs.js'

interface PrefsRow {
  scope: string
  data: string | null
  version: number | bigint | null
  updated_at: string | null
}

function parseData(scope: string, userId: string, raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // A corrupt blob must not 500 a whole visit, and it must not look like "you have no marks"
    // either — an empty scope at version N is what the client would then merge into and write
    // back, erasing the row. Logged for triage; the client keeps its local copy and re-uploads.
    console.error(`[prefs] corrupt blob for user=${userId} scope=${scope}`)
    return {}
  }
}

// Everything in one read: a visit costs one request, and the client needs every scope anyway to
// merge what a second device added while this one was away.
export async function listPrefs(userId: string): Promise<PrefsScopeRow[]> {
  const rows = await query<PrefsRow>(
    `DECLARE $user_id AS Utf8;
     SELECT scope, data, version, updated_at FROM user_prefs WHERE user_id = $user_id;`,
    { $user_id: TypedValues.utf8(userId) },
  )
  return rows.map((r) => ({
    scope: r.scope,
    version: Number(r.version ?? 0),
    updatedAt: Number(r.updated_at) || 0,
    data: parseData(r.scope, userId, r.data),
  }))
}

export type PrefsWriteResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'stale'; current: PrefsScopeRow }
  | { ok: false; reason: 'quota' }

/**
 * Write one scope if it still holds the version the client merged from. Read and write happen in
 * one serializable transaction, so two devices saving at the same moment cannot both win: the
 * loser is handed the row that beat it and merges again. A stale write returns the current row
 * rather than just a code, which saves the retry a round trip — the client already has to fetch
 * it to merge.
 */
export async function writePrefsScope(input: {
  userId: string
  scope: string
  expectedVersion: number
  json: string
  updatedAtMs: number
  nowIso: string
  maxScopes: number
}): Promise<PrefsWriteResult> {
  return transaction(async (run) => {
    const stored = await run<PrefsRow>(
      `DECLARE $user_id AS Utf8;
       DECLARE $scope AS Utf8;
       SELECT scope, data, version, updated_at FROM user_prefs
       WHERE user_id = $user_id AND scope = $scope;`,
      { $user_id: TypedValues.utf8(input.userId), $scope: TypedValues.utf8(input.scope) },
    )
    const row = stored[0]
    const version = Number(row?.version ?? 0)
    if (version !== input.expectedVersion) {
      return {
        ok: false as const,
        reason: 'stale' as const,
        current: {
          scope: input.scope,
          version,
          updatedAt: Number(row?.updated_at) || 0,
          data: parseData(input.scope, input.userId, row?.data ?? null),
        },
      }
    }

    if (!row) {
      const counted = await run<{ cnt: number | bigint }>(
        `DECLARE $user_id AS Utf8;
         SELECT COUNT(*) AS cnt FROM user_prefs WHERE user_id = $user_id;`,
        { $user_id: TypedValues.utf8(input.userId) },
      )
      if (Number(counted[0]?.cnt ?? 0) >= input.maxScopes) return { ok: false as const, reason: 'quota' as const }
    }

    const next = version + 1
    await run(
      `DECLARE $user_id AS Utf8;
       DECLARE $scope AS Utf8;
       DECLARE $data AS Utf8;
       DECLARE $version AS Uint32;
       DECLARE $updated_at AS Utf8;
       DECLARE $server_updated_at AS Utf8;
       UPSERT INTO user_prefs (user_id, scope, data, version, updated_at, server_updated_at)
       VALUES ($user_id, $scope, $data, $version, $updated_at, $server_updated_at);`,
      {
        $user_id: TypedValues.utf8(input.userId),
        $scope: TypedValues.utf8(input.scope),
        $data: TypedValues.utf8(input.json),
        $version: TypedValues.uint32(next),
        $updated_at: TypedValues.utf8(String(input.updatedAtMs)),
        $server_updated_at: TypedValues.utf8(input.nowIso),
      },
    )
    return { ok: true as const, version: next }
  })
}
