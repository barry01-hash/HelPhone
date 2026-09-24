/**
 * Database migration runner for HelPhone.
 *
 * Applies `.sql` files from the repo `migrations/` directory in filename
 * (lexicographic = chronological) order, records each one in the
 * `schema_migrations` table with a content checksum, and never re-applies a
 * migration whose filename + checksum already exist.
 *
 * Notable behaviours:
 *  - Files containing `CONCURRENTLY` (e.g. CREATE INDEX CONCURRENTLY) cannot
 *    run inside a transaction block, so they are applied statement-by-statement
 *    OUTSIDE a transaction.
 *  - If Postgres is not reachable / not configured (e.g. the in-memory mock
 *    pool used by tests), startup migration is skipped gracefully instead of
 *    crashing the server.
 *
 * Usage:
 *   import { runMigrationsAtStartup } from './migrator.js'
 *   await runMigrationsAtStartup()
 *
 *   tsx server/db/migrator.ts   # CLI: migrate + print report
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const schemaMigrationsTable = 'schema_migrations';

export interface MigrationFile {
  filename: string;
  path: string;
  sql: string;
  checksum: string;
}

export interface MigrationRecord {
  filename: string;
  appliedAt: string;
  checksum: string;
}

export interface MigrationRunner {
  name: string;
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

export interface MigrationRunReport {
  applied: string[];
  upgraded: string[];
  skipped: string[];
  error?: string;
  reason?: string;
}

export interface RunMigrationsOptions {
  /** Directory containing the `.sql` migrations. Defaults to `<repo>/migrations`. */
  migrationsDir?: string;
  /** Query runner (client or pool). Defaults to an acquired pool client. */
  runner?: MigrationRunner;
  /** Logger. Defaults to console.log. */
  log?: (message: string, ...args: unknown[]) => void;
}

export function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'migrations');
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir).catch(() => []);
  const sqlFiles = entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  const files: MigrationFile[] = [];
  for (const name of sqlFiles) {
    const fullPath = resolve(dir, name);
    const sql = await readFile(fullPath, 'utf8');
    files.push({
      filename: name,
      path: fullPath,
      sql,
      checksum: checksumOf(sql),
    });
  }
  return files;
}

/**
 * Split a SQL script into individual statements.
 *
 * Honors single-quoted strings (with '' escapes), double-quoted identifiers,
 * line comments (`--`), and dollar-quoted strings (`$tag$ ... $tag$`) so that
 * semicolons inside literals never split a statement.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
      // line comment — skip to end of line
      while (i < n && sql[i] !== '\n') {
        current += sql[i];
        i++;
      }
      current += '\n';
      i++;
      continue;
    }

    if (ch === "'") {
      current += ch;
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          current += "'";
          i++;
          if (sql[i] === "'") {
            // escaped quote ''
            current += "'";
            i++;
            continue;
          }
          break;
        }
        current += sql[i];
        i++;
      }
      continue;
    }

    if (ch === '"') {
      current += ch;
      i++;
      while (i < n && sql[i] !== '"') {
        current += sql[i];
        i++;
      }
      if (i < n) {
        current += '"';
        i++;
      }
      continue;
    }

    if (ch === '$') {
      const match = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        current += tag;
        i += tag.length;
        const close = sql.indexOf(tag, i);
        if (close === -1) {
          current += sql.slice(i);
          i = n;
        } else {
          current += sql.slice(i, close + tag.length);
          i = close + tag.length;
        }
        continue;
      }
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const trailing = current.trim();
  if (trailing.length > 0) statements.push(trailing);
  return statements;
}

export function containsConcurrently(sql: string): boolean {
  return /(^|\s)(CREATE\s+INDEX|DROP\s+INDEX|REINDEX)\b[^;]*CONCURRENTLY/i.test(sql) ||
    /\bCONCURRENTLY\b/i.test(sql);
}

export async function ensureSchemaMigrationsTable(runner: MigrationRunner): Promise<void> {
  await runner.query(
    `CREATE TABLE IF NOT EXISTS ${schemaMigrationsTable} (` +
      `filename TEXT PRIMARY KEY, ` +
      `checksum TEXT NOT NULL, ` +
      `applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  );
}

export async function getAppliedMigrations(runner: MigrationRunner): Promise<MigrationRecord[]> {
  const result = await runner.query(
    `SELECT filename, checksum, to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "appliedAt" FROM ${schemaMigrationsTable}`
  );
  return (result.rows as MigrationRecord[]).slice();
}

/**
 * Best-effort liveness check: a real Postgres always returns at least one row
 * for `SELECT to_regclass(...)`, while the in-memory mock used in tests
 * returns an empty rows array.
 */
export async function isLiveDatabase(runner: MigrationRunner): Promise<boolean> {
  try {
    const result = await runner.query(`SELECT to_regclass('${schemaMigrationsTable}') AS present`);
    return Array.isArray(result.rows) && result.rows.length > 0;
  } catch {
    return false;
  }
}

async function applyMigration(
  runner: MigrationRunner,
  migration: MigrationFile,
  log: (message: string, ...args: unknown[]) => void
): Promise<void> {
  const statements = splitStatements(migration.sql);
  const nonTransactional = containsConcurrently(migration.sql);
  const statementsSql = statements.filter((s) => s.length > 0);

  if (statementsSql.length === 0) {
    // Empty migration — still record it.
    await runner.query(`INSERT INTO ${schemaMigrationsTable} (filename, checksum) VALUES ($1, $2)`, [
      migration.filename,
      migration.checksum,
    ]);
    return;
  }

  const record = `INSERT INTO ${schemaMigrationsTable} (filename, checksum) VALUES ($1, $2)`;
  const params: unknown[] = [migration.filename, migration.checksum];

  if (!nonTransactional) {
    await runner.query('BEGIN');
    try {
      for (const statement of statementsSql) {
        await runner.query(statement);
      }
      await runner.query(record, params);
      await runner.query('COMMIT');
      log(`[migrate] applied ${migration.filename}`);
    } catch (err) {
      await runner.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } else {
    // CONCURRENTLY statements must run outside a transaction. Each statement
    // autocommits; the bookkeeping row is inserted only after all succeed so a
    // failed run re-tries the whole file next time.
    log(`[migrate] applying ${migration.filename} (non-transactional: CONCURRENTLY detected)`);
    for (const statement of statementsSql) {
      await runner.query(statement);
    }
    await runner.query(record, params);
    log(`[migrate] applied ${migration.filename}`);
  }
}

export async function runMigrations(options: RunMigrationsOptions = {}): Promise<MigrationRunReport> {
  const dir = options.migrationsDir ?? defaultMigrationsDir();
  const log = options.log ?? ((message: string, ...args: unknown[]) => console.log(message, ...args));
  const report: MigrationRunReport = { applied: [], upgraded: [], skipped: [] };

  let active = options.runner;
  let acquired: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; release: () => void } | undefined;

  if (!active) {
    const { getClient } = await import('./connection.js');
    const client = await getClient();
    acquired = client;
    active = {
      name: 'pool-client',
      query: (sql: string, params?: unknown[]) => client.query(sql, params),
    };
  }

  try {
    if (!active) {
      report.error = 'No migration runner available';
      return report;
    }

    const live = await isLiveDatabase(active);
    if (!live) {
      report.skipped = ['all'];
      report.reason =
        'Postgres is not reachable (no live database detected); skipping schema migrations';
      log('[migrate] ' + report.reason);
      return report;
    }

    const files = await readMigrationFiles(dir);
    if (files.length === 0) {
      report.reason = `no migrations found in ${dir}`;
      log('[migrate] ' + report.reason);
      return report;
    }

    await ensureSchemaMigrationsTable(active);
    const applied = await getAppliedMigrations(active);
    const appliedByFile = new Map(applied.map((r) => [r.filename, r]));

    for (const migration of files) {
      const existing = appliedByFile.get(migration.filename);
      if (existing) {
        if (existing.checksum === migration.checksum) {
          report.skipped.push(migration.filename);
          continue;
        }
        // Checksum changed — treat as an upgrade: re-apply.
        log(`[migrate] upgrading ${migration.filename} (checksum changed)`);
        await applyMigration(active, migration, log);
        report.upgraded.push(migration.filename);
        continue;
      }
      await applyMigration(active, migration, log);
      report.applied.push(migration.filename);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.error = message;
    log('[migrate] error: ' + message);
  } finally {
    if (acquired && typeof acquired.release === 'function') {
      try {
        acquired.release();
      } catch {}
    }
  }

  return report;
}

/**
 * Startup hook: safely migrates the schema on boot. Never throws — on failure
 * it logs and returns an error-carrying report so the server can still serve
 * degraded while an operator investigates.
 */
export async function runMigrationsAtStartup(options: Omit<RunMigrationsOptions, 'runner'> = {}): Promise<MigrationRunReport> {
  const report = await runMigrations(options);
  return report;
}

// CLI mode: `tsx server/db/migrator.ts` (only when THIS file is the entry —
// the .js mirror has its own guard, so a ts run never triggers the js one).
const ranViaCli = process.argv[1] && process.argv[1].endsWith('migrator.ts');

if (ranViaCli) {
  const report = await runMigrationsAtStartup();
  console.log('[migrate] report:', report);
  if (report.error) process.exitCode = 1;
}

export default { runMigrations, runMigrationsAtStartup, readMigrationFiles, splitStatements };