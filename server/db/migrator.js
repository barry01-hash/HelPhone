/**
 * Database migration runner — JS runtime (mirrors server/db/migrator.ts).
 *
 * See migrator.ts for full docs. Summary: applies `migrations/*.sql` in
 * filename order, records each file + checksum in `schema_migrations`, skips
 * already-applied files, re-applies files whose checksum changed, and runs
 * CONCURRENTLY statements outside a transaction block.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const schemaMigrationsTable = 'schema_migrations';

export function defaultMigrationsDir() {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', '..', 'migrations');
}

export function checksumOf(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function readMigrationFiles(dir) {
  const entries = await readdir(dir).catch(() => []);
  const sqlFiles = entries
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
  const files = [];
  for (const name of sqlFiles) {
    const fullPath = join(dir, name);
    const sql = await readFile(fullPath, 'utf8');
    files.push({ filename: name, path: fullPath, sql, checksum: checksumOf(sql) });
  }
  return files;
}

export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    if (ch === '-' && sql[i + 1] === '-') {
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

export function containsConcurrently(sql) {
  return (
    /(^|\s)(CREATE\s+INDEX|DROP\s+INDEX|REINDEX)\b[^;]*CONCURRENTLY/i.test(sql) ||
    /\bCONCURRENTLY\b/i.test(sql)
  );
}

export async function ensureSchemaMigrationsTable(runner) {
  await runner.query(
    `CREATE TABLE IF NOT EXISTS ${schemaMigrationsTable} (` +
      `filename TEXT PRIMARY KEY, ` +
      `checksum TEXT NOT NULL, ` +
      `applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`
  );
}

export async function getAppliedMigrations(runner) {
  const result = await runner.query(
    `SELECT filename, checksum, to_char(applied_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "appliedAt" FROM ${schemaMigrationsTable}`
  );
  return (result.rows || []).slice();
}

export async function isLiveDatabase(runner) {
  try {
    const result = await runner.query(`SELECT to_regclass('${schemaMigrationsTable}') AS present`);
    return Array.isArray(result.rows) && result.rows.length > 0;
  } catch {
    return false;
  }
}

async function applyMigration(runner, migration, log) {
  const statements = splitStatements(migration.sql);
  const statementsSql = statements.filter((s) => s.length > 0);

  if (statementsSql.length === 0) {
    await runner.query(
      `INSERT INTO ${schemaMigrationsTable} (filename, checksum) VALUES ($1, $2)`,
      [migration.filename, migration.checksum]
    );
    return;
  }

  const nonTransactional = containsConcurrently(migration.sql);
  const record = `INSERT INTO ${schemaMigrationsTable} (filename, checksum) VALUES ($1, $2)`;
  const params = [migration.filename, migration.checksum];

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
    log(`[migrate] applying ${migration.filename} (non-transactional: CONCURRENTLY detected)`);
    for (const statement of statementsSql) {
      await runner.query(statement);
    }
    await runner.query(record, params);
    log(`[migrate] applied ${migration.filename}`);
  }
}

export async function runMigrations(options = {}) {
  const dir = options.migrationsDir ?? defaultMigrationsDir();
  const log = options.log ?? ((message, ...args) => console.log(message, ...args));
  const report = { applied: [], upgraded: [], skipped: [] };

  let active = options.runner;
  let acquired;

  if (!active) {
    const { getClient } = await import('./connection.js');
    const client = await getClient();
    acquired = client;
    active = {
      name: 'pool-client',
      query: (sql, params) => client.query(sql, params),
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
      report.reason = 'Postgres is not reachable (no live database detected); skipping schema migrations';
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

export async function runMigrationsAtStartup(options = {}) {
  return runMigrations(options);
}

// CLI mode: `node server/db/migrator.js` or `tsx server/db/migrator.ts`
// (only when THIS file is the entry — the .ts source has its own guard).
const ranViaCli = process.argv[1] && process.argv[1].endsWith('migrator.js');

if (ranViaCli) {
  const report = await runMigrationsAtStartup();
  console.log('[migrate] report:', report);
  if (report.error) process.exitCode = 1;
}

export default { runMigrations, runMigrationsAtStartup, readMigrationFiles, splitStatements };