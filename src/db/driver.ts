import { Driver, TokenAuthService, Ydb, type IAuthService } from 'ydb-sdk'
import { config } from '../config.js'
import { MetadataTokenAuthService } from './metadata-auth.js'

// Module-scope singleton so warm invocations reuse the gRPC connection (per Yandex guidance —
// creating a Driver per request kills cold-start budget and leaks connections).
let driverPromise: Promise<Driver> | null = null

function makeAuthService(): IAuthService {
  // Local dev: an IAM token via YDB_ACCESS_TOKEN. In YCF the token is empty and we use the
  // function's attached service account through the metadata endpoint.
  if (config.ydb.accessToken) {
    return new TokenAuthService(config.ydb.accessToken)
  }
  return new MetadataTokenAuthService()
}

export function getDriver(): Promise<Driver> {
  if (!driverPromise) {
    driverPromise = (async () => {
      const driver = new Driver({
        endpoint: config.ydb.endpoint,
        database: config.ydb.database,
        authService: makeAuthService(),
      })
      const ready = await driver.ready(10_000)
      if (!ready) throw new Error('YDB driver failed to become ready within 10s')
      return driver
    })()
  }
  return driverPromise
}

export type QueryParams = Record<string, Ydb.ITypedValue>

/**
 * Run a parameterized YQL query via the Query Service and return rows as plain JS objects.
 * Param keys must include the leading `$`; values are ydb-sdk TypedValues.
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  parameters: QueryParams = {},
): Promise<T[]> {
  const driver = await getDriver()
  return driver.queryClient.do({
    fn: async (session) => {
      const { resultSets } = await session.execute({ text, parameters })
      const out: T[] = []
      for await (const rs of resultSets) {
        for await (const row of rs.rows) out.push(row as T)
      }
      return out
    },
  })
}

/** Run a DDL / scheme statement (CREATE TABLE, ALTER TABLE, ...). */
export async function executeScheme(text: string): Promise<void> {
  await query(text)
}
