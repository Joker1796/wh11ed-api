// `Driver` comes off the default export on purpose. ydb-sdk 5.11.1 ships an ESM build whose named
// exports are missing exactly one thing — Driver — while TokenAuthService, TypedValues and Ydb are
// all exported by name. Importing Driver by name works under esbuild (which is how the deployed
// bundle is built) but throws `does not provide an export named 'Driver'` under Node's own ESM
// resolution, which is what `npm run migrate` and `npm run dev` use. Off the default export it
// works under both. Drop this the day upstream fixes its ESM build.
import ydb, { TokenAuthService, Ydb, type IAuthService, type Driver } from 'ydb-sdk'

const { Driver: DriverClass } = ydb
import { toSnakeCaseKeys } from './rows.js'
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
      const driver = new DriverClass({
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
        for await (const row of rs.rows) out.push(toSnakeCaseKeys(row) as T)
      }
      return out
    },
  })
}

/** Run a DDL / scheme statement (CREATE TABLE, ALTER TABLE, ...). */
export async function executeScheme(text: string): Promise<void> {
  await query(text)
}
