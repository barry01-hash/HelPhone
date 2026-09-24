import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The JS mirror is what Node/runtime/test tooling loads; the TS module is the
// source of truth and must stay in sync (both are kept in the repo).
import {
  readMigrationFiles,
  splitStatements,
  containsConcurrently,
  checksumOf,
  ensureSchemaMigrationsTable,
  getAppliedMigrations,
  isLiveDatabase,
  runMigrations,
} from '../server/db/migrator.js'

/**
 * A fake Postgres runner that behaves like a real client minus the network:
 *  - SELECT to_regclass(...) returns one row (so isLiveDatabase() is true)
 *  - BEGIN/COMMIT/ROLLBACK toggle an in-txn flag
 *  - CREATE TABLE / INSERT are recorded
 *  - every query is logged for assertions
 */
function createFakeDb(initialRows = {}) {
  const appliedFileChecksums = new Map()
  const log = []
  let inTxn = false

  function definedTables() {
    const recorded = log.filter((e) => /CREATE TABLE IF NOT EXISTS/i.test(e.sql))
    if (recorded.length > 0) return ['schema_migrations']
    return []
  }

  const runner = {
    name: 'fake-pg',
    async query(sql, params) {
      log.push({ sql, params })
      if (/^BEGIN/i.test(sql)) {
        inTxn = true
        return { rows: [] }
      }
      if (/^COMMIT/i.test(sql)) {
        inTxn = false
        return { rows: [] }
      }
      if (/^ROLLBACK/i.test(sql)) {
        inTxn = false
        return { rows: [] }
      }
      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(sql)) {
        return { rows: [] }
      }
      if (/SELECT to_regclass/i.test(sql)) {
        return { rows: [{ present: 'schema_migrations' }] }
      }
      if (/SELECT filename, checksum/i.test(sql)) {
        const rows = []
        for (const [filename, checksum] of appliedFileChecksums) {
          rows.push({ filename, checksum, appliedAt: '2026-01-01T00:00:00.000Z' })
        }
        return { rows }
      }
      if (/INSERT INTO schema_migrations/i.test(sql)) {
        appliedFileChecksums.set(params[0], params[1])
        return { rows: [] }
      }
      return { rows: [] }
    },
  }

  return { runner, log, state: { appliedFileChecksums }, inTxn: () => inTxn }
}

function makeTempMigrations(files) {
  const dir = mkdtempSync(join(tmpdir(), 'helmig-'))
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql)
  }
  return dir
}

describe('db migrations (#519)', () => {
  let dir
  let db

  beforeEach(() => {
    db = createFakeDb()
    dir = makeTempMigrations({})
  })

  afterEach(() => {
    // best-effort cleanup
    try {
      for (const f of readdirSync(dir)) void f
    } catch {}
  })

  it('splits SQL statements while respecting quotes, comments, and dollar-quotes', () => {
    const sql = [
      `INSERT INTO x VALUES ('a;b');`,
      `-- comment; with semicolon`,
      `SELECT "weird;name" FROM t;`,
      `DO $fn$ BEGIN RAISE NOTICE 'x;y'; END $fn$;`,
      `CREATE TABLE z (id int);`,
    ].join('\n')
    const stmts = splitStatements(sql)
    expect(stmts).toHaveLength(4)
    expect(stmts[0]).toContain("'a;b'")
    expect(stmts[1]).toContain('"weird;name"')
    expect(stmts[2]).toContain('$fn$')
    expect(stmts[3]).toBe('CREATE TABLE z (id int)')
  })

  it('detects CONCURRENTLY statements', () => {
    expect(containsConcurrently('CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (c)')).toBe(true)
    expect(containsConcurrently('DROP INDEX CONCURRENTLY a')).toBe(true)
    expect(containsConcurrently('CREATE INDEX IF NOT EXISTS a ON t (c)')).toBe(false)
  })

  it('reads and checksums migration files in filename order', async () => {
    dir = makeTempMigrations({
      '20260501000000_a.sql': 'CREATE TABLE a (id int);',
      '20260502000000_b.sql': 'CREATE TABLE b (id int);',
    })
    const files = await readMigrationFiles(dir)
    expect(files.map((f) => f.filename)).toEqual(['20260501000000_a.sql', '20260502000000_b.sql'])
    expect(files[0].checksum).toBe(checksumOf('CREATE TABLE a (id int);'))
    expect(files[0].checksum).toHaveLength(64)
  })

  it('deliberately keeps ts/js mirrors in sync', async () => {
    const dir = makeTempMigrations({
      '20260501000000_a.sql': 'CREATE TABLE a (id int);',
    })
    const files = await readMigrationFiles(dir)
    expect(files).toHaveLength(1)
    // ensureSchemaMigrationsTable + isLiveDatabase use the same table name
    await ensureSchemaMigrationsTable(db.runner)
    expect(isLiveDatabase(db.runner)).resolves.toBe(true)
  })

  it('applies pending migrations in order inside a transaction', async () => {
    dir = makeTempMigrations({
      '20260501000000_a.sql': 'CREATE TABLE a (id int);',
      '20260502000000_b.sql': 'CREATE TABLE b (id int);',
    })

    const msgs = []
    const report = await runMigrations({
      migrationsDir: dir,
      runner: db.runner,
      log: (m) => msgs.push(m),
    })

    expect(report.applied).toEqual(['20260501000000_a.sql', '20260502000000_b.sql'])
    expect(report.error).toBeUndefined()
    // both applied inside a wrapping transaction
    const begins = db.log.filter((e) => /^BEGIN/i.test(e.sql)).length
    const commits = db.log.filter((e) => /^COMMIT/i.test(e.sql)).length
    expect(begins).toBe(2)
    expect(commits).toBe(2)
    // recorded in schema_migrations
    expect([...db.state.appliedFileChecksums.keys()]).toEqual([
      '20260501000000_a.sql',
      '20260502000000_b.sql',
    ])
  })

  it('skips already-applied migrations and re-applies on checksum change', async () => {
    dir = makeTempMigrations({
      '20260501000000_a.sql': 'CREATE TABLE a (id int);',
    })
    const first = await runMigrations({ migrationsDir: dir, runner: db.runner, log: () => {} })
    expect(first.applied).toEqual(['20260501000000_a.sql'])

    // second run — nothing new
    const second = await runMigrations({ migrationsDir: dir, runner: db.runner, log: () => {} })
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(['20260501000000_a.sql'])

    // mutate the file → checksum changes → becomes an upgrade
    writeFileSync(join(dir, '20260501000000_a.sql'), 'CREATE TABLE a (id int); -- updated')
    const third = await runMigrations({ migrationsDir: dir, runner: db.runner, log: () => {} })
    expect(third.upgraded).toEqual(['20260501000000_a.sql'])
  })

  it('runs CONCURRENTLY migrations outside a transaction (statement by statement)', async () => {
    dir = makeTempMigrations({
      '20260501000000_a.sql': 'CREATE TABLE a (id int);',
      '20260502000000_b.sql':
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_a_id ON a (id);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_a_id2 ON a (id);',
    })
    const report = await runMigrations({ migrationsDir: dir, runner: db.runner, log: () => {} })
    expect(report.applied).toEqual(['20260501000000_a.sql', '20260502000000_b.sql'])
    // only migration a gets BEGIN/COMMIT
    const begins = db.log.filter((e) => /^BEGIN/i.test(e.sql)).length
    const commits = db.log.filter((e) => /^COMMIT/i.test(e.sql)).length
    expect(begins).toBe(1)
    expect(commits).toBe(1)
    // CONCURRENTLY file executed its two statements individually without txn
    const concurrently = db.log.filter((e) => /CREATE INDEX CONCURRENTLY/i.test(e.sql))
    expect(concurrently).toHaveLength(2)
  })

  it('is a no-op on a non-live database (reports skipped)', async () => {
    const deadRunner = {
      name: 'mock',
      async query(sql) {
        if (/SELECT to_regclass/i.test(sql)) return { rows: [] }
        return { rows: [] }
      },
    }
    const report = await runMigrations({
      migrationsDir: dir,
      runner: deadRunner,
      log: () => {},
    })
    expect(report.skipped).toEqual(['all'])
    expect(report.reason).toMatch(/Postgres is not reachable/i)
  })

  it('rolls back an errored migration but keeps earlier successful ones', async () => {
    dir = makeTempMigrations({
      '20260501000000_a.sql': 'CREATE TABLE a (id int);',
      '20260502000000_b.sql': 'CREATE TABLE b (id int);',
    })
    const failing = {
      ...db.runner,
      async query(sql, params) {
        if (/CREATE TABLE b/i.test(sql)) throw new Error('syntax error near b')
        return db.runner.query(sql, params)
      },
    }
    const report = await runMigrations({ migrationsDir: dir, runner: failing, log: () => {} })
    expect(report.error).toMatch(/syntax error near b/)
    // 'a' committed independently and stays applied; `b` rolled back entirely
    expect(report.applied).toEqual(['20260501000000_a.sql'])
    expect([...db.state.appliedFileChecksums.keys()]).toEqual(['20260501000000_a.sql'])
    // the failed file's transaction was rolled back (no stray BEGIN left open)
    expect(db.inTxn()).toBe(false)
  })
})