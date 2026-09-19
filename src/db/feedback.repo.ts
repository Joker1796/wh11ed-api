import { TypedValues, Types } from 'ydb-sdk'
import { query } from './driver.js'

// Utf8? param: the sdk has no one-call helper for a NULLABLE typed value, so wrap or null.
const optUtf8 = (v: string | null) =>
  v == null ? TypedValues.optionalNull(Types.UTF8) : TypedValues.optional(TypedValues.utf8(v))

export async function insertFeedback(input: {
  feedbackId: string
  createdAt: string
  userId: string | null
  appVersion: string | null
  route: string | null
  message: string
  contextJson: string | null
  attachmentJson: string | null
}): Promise<void> {
  await query(
    `DECLARE $feedback_id AS Utf8;
     DECLARE $created_at AS Utf8;
     DECLARE $user_id AS Utf8?;
     DECLARE $app_version AS Utf8?;
     DECLARE $route AS Utf8?;
     DECLARE $message AS Utf8;
     DECLARE $context AS Utf8?;
     DECLARE $attachment AS Utf8?;
     UPSERT INTO feedback (feedback_id, created_at, user_id, app_version, route, message, context, attachment)
     VALUES ($feedback_id, $created_at, $user_id, $app_version, $route, $message, $context, $attachment);`,
    {
      $feedback_id: TypedValues.utf8(input.feedbackId),
      $created_at: TypedValues.utf8(input.createdAt),
      $user_id: optUtf8(input.userId),
      $app_version: optUtf8(input.appVersion),
      $route: optUtf8(input.route),
      $message: TypedValues.utf8(input.message),
      $context: optUtf8(input.contextJson),
      $attachment: optUtf8(input.attachmentJson),
    },
  )
}

export interface FeedbackRow {
  feedback_id: string
  created_at: string | null
  user_id: string | null
  app_version: string | null
  route: string | null
  message: string | null
  context: string | null
  attachment: string | null
}

export async function listFeedback(limit: number): Promise<FeedbackRow[]> {
  return query<FeedbackRow>(
    `DECLARE $limit AS Uint64;
     SELECT feedback_id, created_at, user_id, app_version, route, message, context, attachment
     FROM feedback ORDER BY created_at DESC LIMIT $limit;`,
    { $limit: TypedValues.uint64(limit) },
  )
}

// Remove reports that have been dealt with (fixed, answered in the changelog, or judged not a bug)
// so the inbox `npm run feedback:list` prints holds only what is still open — the owner's call
// (2026-09-19) over a "resolved" flag: the verdicts live in the changelog and the hub's journals,
// the table is an inbox, not an archive. Returns the ids actually removed.
export async function deleteFeedback(ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const present = await query<{ feedback_id: string }>(
    `DECLARE $ids AS List<Utf8>;
     SELECT feedback_id FROM feedback WHERE feedback_id IN $ids;`,
    { $ids: TypedValues.list(Types.UTF8, ids) },
  )
  const found = present.map((r) => r.feedback_id)
  if (found.length) {
    await query(
      `DECLARE $ids AS List<Utf8>;
       DELETE FROM feedback WHERE feedback_id IN $ids;`,
      { $ids: TypedValues.list(Types.UTF8, found) },
    )
  }
  return found
}
