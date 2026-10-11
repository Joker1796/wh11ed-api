import postgres, { type Sql, type TransactionSql } from 'postgres'
import { config } from '../config.js'

// One pool per process, made on first use: importing a repo must not open a connection (the
// domain tests import half the tree with no database anywhere), and a long-lived Node server
// reuses the pool for its whole life.
let pool: Sql | null = null

export function db(): Sql {
  if (!pool) {
    pool = postgres(config.databaseUrl, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      // NOTICEs ("relation already exists, skipping" and the like) are not news.
      onnotice: () => {},
    })
  }
  return pool
}

/** Either the pool or an open transaction — what a repo helper needs to run inside both. */
export type Runner = Sql | TransactionSql

export async function closeDb(): Promise<void> {
  if (pool) {
    const p = pool
    pool = null
    await p.end({ timeout: 5 })
  }
}

// serialization_failure and deadlock_detected: the two answers a SERIALIZABLE transaction gets
// when another one won the race. Both mean "run it again", nothing more.
const RETRYABLE = new Set(['40001', '40P01'])
const MAX_ATTEMPTS = 5

/**
 * Run `fn` as ONE serializable transaction, retried when it loses a race. The party sync needs
 * this: "compare the versions the client based its edit on, then write" must be one unit, or two
 * phones writing the same slice in the same instant could both pass the check. Postgres aborts one
 * of the two with 40001 and the retry re-reads what the winner wrote — the same contract YDB's
 * doTx gave, which retried on its own.
 */
export async function transaction<T>(fn: (tx: TransactionSql) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return (await db().begin('isolation level serializable', fn)) as T
    } catch (e) {
      const code = (e as { code?: string }).code
      if (!code || !RETRYABLE.has(code) || attempt >= MAX_ATTEMPTS) throw e
      await new Promise((r) => setTimeout(r, 5 * attempt + Math.random() * 20))
    }
  }
}
