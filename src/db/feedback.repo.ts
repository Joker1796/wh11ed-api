import { db } from './driver.js'

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
  await db()`
    INSERT INTO feedback (feedback_id, created_at, user_id, app_version, route, message, context, attachment)
    VALUES (${input.feedbackId}, ${input.createdAt}, ${input.userId}, ${input.appVersion}, ${input.route},
            ${input.message}, ${input.contextJson}, ${input.attachmentJson})`
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
  return db()<FeedbackRow[]>`
    SELECT feedback_id, created_at, user_id, app_version, route, message, context, attachment
    FROM feedback ORDER BY created_at DESC LIMIT ${limit}`
}

// Remove reports that have been dealt with (fixed, answered in the changelog, or judged not a bug)
// so the inbox `npm run feedback:list` prints holds only what is still open — the owner's call
// (2026-09-19) over a "resolved" flag: the verdicts live in the changelog and the hub's journals,
// the table is an inbox, not an archive. Returns the ids actually removed.
export async function deleteFeedback(ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const removed = await db()<{ feedback_id: string }[]>`
    DELETE FROM feedback WHERE feedback_id IN ${db()(ids)} RETURNING feedback_id`
  return removed.map((r) => r.feedback_id)
}
