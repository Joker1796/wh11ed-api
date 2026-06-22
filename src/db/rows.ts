// ydb-sdk's query client returns row columns as camelCase keys (e.g. `expires_at` → `expiresAt`),
// but the repos/domain read the original snake_case column names. Convert keys back so reads match
// the schema. Values are already native JS (Utf8 → string, Timestamp → Date), so only keys change.
//
// Kept in its own dependency-free module so it stays unit-testable: importing the driver pulls in
// ydb-sdk, which the tsx test runner can't load under Node ≥23 (ESM/CJS interop).
export function toSnakeCaseKeys(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key in row) {
    out[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = row[key]
  }
  return out
}
