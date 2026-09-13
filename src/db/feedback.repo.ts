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
