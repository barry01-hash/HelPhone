// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  quoteIdent,
  isWithinWindow,
  measureBloat,
  runMaintenance,
  startMaintenanceScheduler,
  __resetMaintenanceState,
} from "../server/db/maintenance.ts";
import { getMaintenanceConfig } from "../server/env.ts";
import { shutdownPool } from "../server/db/connection.ts";

const cfg = (over = {}) => ({
  enabled: true,
  bloatThresholdPct: 20,
  windowStartHour: 2,
  windowEndHour: 5,
  intervalMs: 60_000,
  reindexCooldownMs: 1000,
  minTableTuples: 0,
  ...over,
});
const at = (hour) => () => new Date(Date.UTC(2026, 8, 24, hour, 30));
const stat = (relname, live, dead, schemaname = "public") => ({
  schemaname,
  relname,
  n_live_tup: String(live), // pg returns bigint as strings
  n_dead_tup: String(dead),
});

/** Fake query fn: answers the bloat query and records every other statement. */
function fakeDb(rows, { failOn } = {}) {
  const statements = [];
  const query = vi.fn(async (sql) => {
    if (/pg_stat_user_tables/.test(sql)) return { rows };
    statements.push(sql);
    if (failOn && failOn.test(sql)) throw new Error("lock timeout");
    return { rows: [] };
  });
  return { query, statements };
}

beforeEach(() => __resetMaintenanceState());

describe("helpers", () => {
  it("quotes identifiers, escaping embedded quotes", () => {
    expect(quoteIdent("users")).toBe('"users"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it("checks the UTC window, including wrap-around and the 24h case", () => {
    const d = (h) => new Date(Date.UTC(2026, 0, 1, h, 0));
    expect(isWithinWindow(d(2), 2, 5)).toBe(true);
    expect(isWithinWindow(d(4), 2, 5)).toBe(true);
    expect(isWithinWindow(d(5), 2, 5)).toBe(false);
    expect(isWithinWindow(d(1), 2, 5)).toBe(false);
    expect(isWithinWindow(d(23), 22, 4)).toBe(true);
    expect(isWithinWindow(d(3), 22, 4)).toBe(true);
    expect(isWithinWindow(d(12), 22, 4)).toBe(false);
    expect(isWithinWindow(d(12), 0, 0)).toBe(true);
  });
});

describe("measureBloat", () => {
  it("computes dead-tuple % from string counters, worst first", async () => {
    const { query } = fakeDb([
      stat("a", 900, 100),
      stat("b", 50, 50),
      stat("c", 0, 0),
    ]);
    const out = await measureBloat(query);
    expect(out.map((t) => [t.table, t.deadPct])).toEqual([
      ["b", 50],
      ["a", 10],
      ["c", 0],
    ]);
    expect(out[0]).toMatchObject({
      schema: "public",
      liveTuples: 50,
      deadTuples: 50,
    });
  });

  it("treats non-numeric counters as zero", async () => {
    const { query } = fakeDb([
      {
        schemaname: "public",
        relname: "x",
        n_live_tup: null,
        n_dead_tup: "abc",
      },
    ]);
    expect((await measureBloat(query))[0].deadPct).toBe(0);
  });
});

describe("getMaintenanceConfig", () => {
  it("is disabled with documented defaults", () => {
    expect(getMaintenanceConfig({})).toEqual({
      enabled: false,
      bloatThresholdPct: 20,
      windowStartHour: 2,
      windowEndHour: 5,
      intervalMs: 900000,
      reindexCooldownMs: 604800000,
      minTableTuples: 1000,
    });
  });

  it("reads overrides and ignores invalid values", () => {
    const c = getMaintenanceConfig({
      DB_MAINTENANCE_ENABLED: "true",
      DB_BLOAT_THRESHOLD_PCT: "35",
      DB_MAINTENANCE_WINDOW_START_UTC: "22",
      DB_MAINTENANCE_WINDOW_END_UTC: "99", // out of range → default
      DB_MAINTENANCE_INTERVAL_MS: "abc", // NaN → default
      DB_MAINTENANCE_MIN_TUPLES: " ", // blank → default
    });
    expect(c).toMatchObject({
      enabled: true,
      bloatThresholdPct: 35,
      windowStartHour: 22,
      windowEndHour: 5,
      intervalMs: 900000,
      minTableTuples: 1000,
    });
  });
});

describe("runMaintenance", () => {
  it("skips when disabled or outside the window, touching nothing", async () => {
    const { query } = fakeDb([stat("a", 1, 99)]);
    expect(
      await runMaintenance({
        query,
        config: cfg({ enabled: false }),
        now: at(3),
      }),
    ).toEqual({
      skipped: "disabled",
      tables: [],
    });
    expect(await runMaintenance({ query, config: cfg(), now: at(12) })).toEqual(
      {
        skipped: "outside-window",
        tables: [],
      },
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("vacuums then reindexes only tables above the bloat threshold, worst first", async () => {
    const db = fakeDb([
      stat("ok", 900, 100),
      stat("mild", 750, 250),
      stat("bad", 100, 900, "app"),
    ]);
    const report = await runMaintenance({
      query: db.query,
      config: cfg(),
      now: at(3),
    });

    expect(db.statements).toEqual([
      'VACUUM (ANALYZE) "app"."bad"',
      'REINDEX TABLE CONCURRENTLY "app"."bad"',
      'VACUUM (ANALYZE) "public"."mild"',
      'REINDEX TABLE CONCURRENTLY "public"."mild"',
    ]);
    expect(
      report.tables.map((t) => [t.table, t.vacuumed, t.reindexed]),
    ).toEqual([
      ["app.bad", true, true],
      ["public.mild", true, true],
    ]);
  });

  it("does not trigger at exactly the threshold", async () => {
    const db = fakeDb([stat("edge", 80, 20)]); // exactly 20%
    expect(
      (await runMaintenance({ query: db.query, config: cfg(), now: at(3) }))
        .tables,
    ).toEqual([]);
  });

  it("never issues VACUUM FULL or wraps statements in a transaction", async () => {
    const db = fakeDb([stat("bad", 1, 99)]);
    await runMaintenance({ query: db.query, config: cfg(), now: at(3) });
    const sql = db.statements.join("\n");
    expect(sql).not.toMatch(/FULL|BEGIN|COMMIT/i);
    expect(sql).toMatch(/REINDEX TABLE CONCURRENTLY/);
  });

  it("skips tiny tables below minTableTuples", async () => {
    const db = fakeDb([stat("tiny", 1, 9)]);
    const r = await runMaintenance({
      query: db.query,
      config: cfg({ minTableTuples: 100 }),
      now: at(3),
    });
    expect(r.tables).toEqual([]);
  });

  it("re-indexes a table at most once per cooldown but still vacuums it", async () => {
    const db = fakeDb([stat("bad", 1, 99)]);
    let t = Date.UTC(2026, 8, 24, 3, 0);
    const now = () => new Date(t);
    const config = cfg({ reindexCooldownMs: 60_000 });

    await runMaintenance({ query: db.query, config, now });
    t += 10_000;
    const second = await runMaintenance({ query: db.query, config, now });
    expect(second.tables[0]).toMatchObject({
      vacuumed: true,
      reindexed: false,
    });

    t += 120_000;
    const third = await runMaintenance({ query: db.query, config, now });
    expect(third.tables[0].reindexed).toBe(true);
  });

  it("isolates a failing table: records the error and continues", async () => {
    const db = fakeDb([stat("first", 1, 99), stat("second", 10, 90)], {
      failOn: /"first"/,
    });
    const log = vi.fn();
    const report = await runMaintenance({
      query: db.query,
      config: cfg(),
      now: at(3),
      log,
    });

    const byName = Object.fromEntries(report.tables.map((t) => [t.table, t]));
    expect(byName["public.first"]).toMatchObject({
      vacuumed: false,
      error: "lock timeout",
    });
    expect(byName["public.second"]).toMatchObject({
      vacuumed: true,
      reindexed: true,
    });
    expect(log).toHaveBeenCalledWith(
      "[db-maintenance] failed",
      expect.objectContaining({ error: "lock timeout" }),
    );
  });

  it("is single-flight: an overlapping pass is skipped, and the lock is released afterwards", async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = vi.fn(async (sql) => {
      if (/pg_stat_user_tables/.test(sql)) {
        await gate;
        return { rows: [] };
      }
      return { rows: [] };
    });

    const first = runMaintenance({ query: slow, config: cfg(), now: at(3) });
    const overlap = await runMaintenance({
      query: slow,
      config: cfg(),
      now: at(3),
    });
    expect(overlap.skipped).toBe("already-running");

    release();
    await first;
    const after = await runMaintenance({
      query: fakeDb([]).query,
      config: cfg(),
      now: at(3),
    });
    expect(after.skipped).toBeUndefined();
  });

  it("releases the single-flight lock even when the bloat query throws", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("db down"));
    await expect(
      runMaintenance({ query: boom, config: cfg(), now: at(3) }),
    ).rejects.toThrow("db down");
    const ok = await runMaintenance({
      query: fakeDb([]).query,
      config: cfg(),
      now: at(3),
    });
    expect(ok.skipped).toBeUndefined();
  });

  it("defaults to a dedicated pooled client when no query fn is injected", async () => {
    // The test pool's fallback client answers every query with no rows.
    const report = await runMaintenance({ config: cfg(), now: at(3) });
    expect(report).toEqual({ tables: [] });
    await shutdownPool();
  });
});

describe("startMaintenanceScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks on the configured interval and stops on request", async () => {
    const db = fakeDb([]);
    const s = startMaintenanceScheduler({
      query: db.query,
      config: cfg({ intervalMs: 1000 }),
      now: at(3),
      log: () => {},
    });

    await vi.advanceTimersByTimeAsync(3100);
    expect(db.query).toHaveBeenCalledTimes(3);

    s.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it("logs and survives a failing pass instead of an unhandled rejection", async () => {
    const log = vi.fn();
    const query = vi.fn().mockRejectedValue(new Error("db down"));
    const s = startMaintenanceScheduler({
      query,
      config: cfg({ intervalMs: 1000 }),
      now: at(3),
      log,
    });

    expect(await s.tick()).toEqual({ tables: [] });
    expect(log).toHaveBeenCalledWith("[db-maintenance] pass failed", {
      error: "db down",
    });
    s.stop();
  });

  it("does nothing when disabled", async () => {
    const db = fakeDb([]);
    const s = startMaintenanceScheduler({
      query: db.query,
      config: cfg({ enabled: false }),
      now: at(3),
    });
    expect((await s.tick()).skipped).toBe("disabled");
    s.stop();
  });
});
