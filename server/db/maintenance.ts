/**
 * server/db/maintenance.ts — Automated VACUUM ANALYZE / REINDEX scheduler.
 *
 * Every `intervalMs` the scheduler checks whether it is inside the low-traffic
 * UTC window. If so it reads `pg_stat_user_tables`, computes each table's dead
 * tuple percentage and, for tables above the threshold (default 20%), runs
 * `VACUUM (ANALYZE)` followed by `REINDEX TABLE CONCURRENTLY`.
 *
 * "Non-blocking" here means:
 *  - plain `VACUUM` (never `VACUUM FULL`) — it doesn't take an exclusive lock,
 *    so reads and writes continue. PostgreSQL has no `VACUUM ... CONCURRENTLY`.
 *  - `REINDEX ... CONCURRENTLY` (PostgreSQL 12+) builds the new index alongside
 *    the old one without blocking writes.
 * Both statements refuse to run inside a transaction block, so each one is sent
 * on its own through a dedicated client and never wrapped in BEGIN/COMMIT.
 *
 * Runs are single-flight (overlapping ticks are skipped) and one table failing
 * never aborts the rest of the pass.
 */
import { getMaintenanceConfig, type MaintenanceConfig } from '../env.js'
import { withClient } from './connection.js'

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

export interface TableBloat {
  schema: string
  table: string
  liveTuples: number
  deadTuples: number
  /** dead / (live + dead) × 100 */
  deadPct: number
}

export interface TableResult {
  table: string
  deadPct: number
  vacuumed: boolean
  reindexed: boolean
  error?: string
}

export interface MaintenanceReport {
  /** Why nothing ran, when nothing did. */
  skipped?: 'disabled' | 'outside-window' | 'already-running'
  tables: TableResult[]
}

export interface MaintenanceDeps {
  /** Runs one statement outside any transaction. Defaults to a dedicated pooled client. */
  query?: QueryFn
  config?: MaintenanceConfig
  now?: () => Date
  log?: (msg: string, meta?: Record<string, unknown>) => void
}

const BLOAT_SQL = `SELECT schemaname, relname, n_live_tup, n_dead_tup
FROM pg_stat_user_tables
WHERE n_dead_tup > 0`

/** Quote a SQL identifier (schema/table names come from the catalog, but be safe). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** True when `date`'s UTC hour is in [start, end); a window may wrap midnight. */
export function isWithinWindow(date: Date, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true // 24h window
  const h = date.getUTCHours()
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour
}

const toNumber = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Dead-tuple percentage for every table with dead tuples, worst first. */
export async function measureBloat(query: QueryFn): Promise<TableBloat[]> {
  const { rows } = await query(BLOAT_SQL)
  return (rows as Array<Record<string, unknown>>)
    .map((r) => {
      const liveTuples = toNumber(r.n_live_tup)
      const deadTuples = toNumber(r.n_dead_tup)
      const total = liveTuples + deadTuples
      return {
        schema: String(r.schemaname),
        table: String(r.relname),
        liveTuples,
        deadTuples,
        deadPct: total > 0 ? (deadTuples / total) * 100 : 0,
      }
    })
    .sort((a, b) => b.deadPct - a.deadPct)
}

const lastReindexed = new Map<string, number>()
let running = false

/** Test hook: clear the cooldown and single-flight state. */
export function __resetMaintenanceState(): void {
  lastReindexed.clear()
  running = false
}

export async function runMaintenance(deps: MaintenanceDeps = {}): Promise<MaintenanceReport> {
  const config = deps.config ?? getMaintenanceConfig()
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? (() => {})

  if (!config.enabled) return { skipped: 'disabled', tables: [] }
  if (!isWithinWindow(now(), config.windowStartHour, config.windowEndHour)) {
    return { skipped: 'outside-window', tables: [] }
  }
  if (running) return { skipped: 'already-running', tables: [] }

  running = true
  try {
    const exec = async (fn: (query: QueryFn) => Promise<TableResult[]>): Promise<TableResult[]> =>
      deps.query ? fn(deps.query) : withClient((client) => fn((sql, params) => client.query(sql, params)))

    const tables = await exec(async (query) => {
      const candidates = (await measureBloat(query)).filter(
        (t) => t.deadPct > config.bloatThresholdPct && t.liveTuples + t.deadTuples >= config.minTableTuples
      )
      const results: TableResult[] = []

      for (const t of candidates) {
        const qualified = `${quoteIdent(t.schema)}.${quoteIdent(t.table)}`
        const result: TableResult = { table: `${t.schema}.${t.table}`, deadPct: t.deadPct, vacuumed: false, reindexed: false }
        try {
          await query(`VACUUM (ANALYZE) ${qualified}`)
          result.vacuumed = true
          log('[db-maintenance] vacuumed', { table: result.table, deadPct: t.deadPct })

          const last = lastReindexed.get(result.table)
          if (last === undefined || now().getTime() - last >= config.reindexCooldownMs) {
            await query(`REINDEX TABLE CONCURRENTLY ${qualified}`)
            lastReindexed.set(result.table, now().getTime())
            result.reindexed = true
            log('[db-maintenance] reindexed', { table: result.table })
          }
        } catch (err) {
          result.error = (err as Error).message
          log('[db-maintenance] failed', { table: result.table, error: result.error })
        }
        results.push(result)
      }
      return results
    })
    return { tables }
  } finally {
    running = false
  }
}

export interface MaintenanceScheduler {
  stop(): void
  /** Run one pass immediately (used by tests and manual triggers). */
  tick(): Promise<MaintenanceReport>
}

/** Start the periodic scheduler. The timer is unref'd so it never keeps Node alive. */
export function startMaintenanceScheduler(deps: MaintenanceDeps = {}): MaintenanceScheduler {
  const config = deps.config ?? getMaintenanceConfig()
  const log = deps.log ?? ((msg, meta) => console.log(msg, meta ?? ''))
  const tick = () =>
    runMaintenance({ ...deps, config, log }).catch((err): MaintenanceReport => {
      log('[db-maintenance] pass failed', { error: (err as Error).message })
      return { tables: [] }
    })

  const timer = setInterval(() => void tick(), config.intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), tick }
}
