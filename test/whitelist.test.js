// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import {
  parseIp,
  parseCidr,
  formatCidr,
  ipInCidr,
  hashApiKey,
  createMemoryRedis,
  createWhitelistStore,
  createWhitelistMiddleware,
  createWhitelistAdminRouter,
  createDefaultRedisClient,
  isWhitelisted,
  SUBNETS_KEY,
} from "../server/middleware/whitelist.ts";
import { createRateLimiter } from "../server/index.js";
import {
  getRedis,
  isRedisConfigured,
  __setRedisForTests,
} from "../server/lib/redis.ts";

const inside = (ip, cidr) => ipInCidr(ip, parseCidr(cidr));

describe("IP / CIDR parsing", () => {
  it("parses IPv4 and rejects malformed addresses", () => {
    expect(parseIp("10.0.0.1")).toEqual({ version: 4, value: 167772161n });
    for (const bad of [
      "",
      "1.2.3",
      "1.2.3.4.5",
      "256.0.0.1",
      "a.b.c.d",
      "01234.1.1.1",
      null,
      undefined,
    ]) {
      expect(parseIp(bad)).toBeNull();
    }
  });

  it("parses IPv6 including :: compression, embedded IPv4 and zone ids", () => {
    expect(parseIp("::1")).toEqual({ version: 6, value: 1n });
    expect(parseIp("2001:db8::1")?.version).toBe(6);
    expect(parseIp("fe80::1%eth0")?.version).toBe(6);
    expect(parseIp("1:2:3:4:5:6:7:8")?.version).toBe(6);
    for (const bad of [
      "1::2::3",
      "1:2:3:4:5:6:7",
      "12345::1",
      "g::1",
      "1:2:3:4:5:6:7:8:9",
      "::1.2.3",
    ]) {
      expect(parseIp(bad)).toBeNull();
    }
  });

  it("treats IPv4-mapped IPv6 as IPv4", () => {
    expect(parseIp("::ffff:192.168.1.5")).toEqual(parseIp("192.168.1.5"));
    expect(parseIp("::ffff:c0a8:0105")).toEqual(parseIp("192.168.1.5"));
  });

  it("parses CIDRs, masking host bits, and validates prefixes", () => {
    expect(formatCidr(parseCidr("203.0.113.77/24"))).toBe("203.0.113.0/24");
    expect(formatCidr(parseCidr("203.0.113.77"))).toBe("203.0.113.77/32");
    expect(formatCidr(parseCidr("2001:db8::1/32"))).toBe(
      "2001:db8:0:0:0:0:0:0/32",
    );
    for (const bad of [
      "1.2.3.4/33",
      "::1/129",
      "1.2.3.4/x",
      "1.2.3.4/8/8",
      "nope/8",
      "1.2.3.4/-1",
    ]) {
      expect(parseCidr(bad)).toBeNull();
    }
    expect(formatCidr(parseCidr("0.0.0.0/0"))).toBe("0.0.0.0/0");
  });

  it("matches addresses inside a subnet and not outside, per address family", () => {
    expect(inside("203.0.113.5", "203.0.113.0/24")).toBe(true);
    expect(inside("203.0.114.5", "203.0.113.0/24")).toBe(false);
    expect(inside("203.0.113.5", "203.0.113.5/32")).toBe(true);
    expect(inside("203.0.113.6", "203.0.113.5/32")).toBe(false);
    expect(inside("2001:db8::abcd", "2001:db8::/32")).toBe(true);
    expect(inside("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(inside("::ffff:203.0.113.5", "203.0.113.0/24")).toBe(true);
    // A v6 address never matches a v4 subnet and vice versa.
    expect(inside("2001:db8::1", "0.0.0.0/0")).toBe(false);
    expect(inside("1.2.3.4", "::/0")).toBe(false);
    expect(inside("garbage", "0.0.0.0/0")).toBe(false);
    expect(inside(undefined, "0.0.0.0/0")).toBe(false);
  });
});

describe("whitelist store", () => {
  let store;
  beforeEach(() => {
    store = createWhitelistStore(createMemoryRedis());
  });

  it("adds, lists and removes subnets under a canonical CIDR", async () => {
    const entry = await store.addSubnet("203.0.113.9/24", "County 911");
    expect(entry.cidr).toBe("203.0.113.0/24");
    expect(await store.listSubnets()).toEqual([entry]);
    expect(await store.removeSubnet("203.0.113.200/24")).toBe(true);
    expect(await store.removeSubnet("203.0.113.0/24")).toBe(false);
    expect(await store.removeSubnet("not-a-cidr")).toBe(false);
    expect(await store.listSubnets()).toEqual([]);
  });

  it("rejects an invalid CIDR", async () => {
    await expect(store.addSubnet("nope", "x")).rejects.toThrow(/Invalid CIDR/);
  });

  it("stores API keys only as hashes and looks them up by plaintext", async () => {
    const redis = createMemoryRedis();
    const s = createWhitelistStore(redis);
    const entry = await s.addApiKey("hp_secret", "Dispatch CAD");
    expect(entry.id).toBe(hashApiKey("hp_secret").slice(0, 16));
    expect(await s.hasApiKey("hp_secret")).toBe(true);
    expect(await s.hasApiKey("hp_other")).toBe(false);
    expect(
      JSON.stringify(await redis.hgetall("whitelist:api-keys")),
    ).not.toContain("hp_secret");
    expect(await s.listApiKeys()).toEqual([entry]);
    expect(await s.removeApiKey("missing")).toBe(false);
    expect(await s.removeApiKey(entry.id)).toBe(true);
    expect(await s.hasApiKey("hp_secret")).toBe(false);
  });

  it("skips corrupt records instead of throwing", async () => {
    const redis = createMemoryRedis();
    await redis.hset(SUBNETS_KEY, "1.2.3.0/24", "{not json");
    await redis.hset("whitelist:api-keys", "abc", "{not json");
    const s = createWhitelistStore(redis);
    expect(await s.listSubnets()).toEqual([]);
    expect(await s.listApiKeys()).toEqual([]);
  });
});

describe("whitelist middleware", () => {
  const run = async (mw, req) => {
    const next = vi.fn();
    const full = { headers: {}, ...req };
    await mw(full, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
    return full;
  };

  it("flags requests from a whitelisted subnet", async () => {
    const store = createWhitelistStore(createMemoryRedis());
    await store.addSubnet("203.0.113.0/24", "");
    const mw = createWhitelistMiddleware(store);
    expect(isWhitelisted(await run(mw, { ip: "203.0.113.10" }))).toBe(true);
    expect(isWhitelisted(await run(mw, { ip: "198.51.100.10" }))).toBe(false);
  });

  it("flags requests carrying a registered API key, ignoring unknown or non-string keys", async () => {
    const store = createWhitelistStore(createMemoryRedis());
    await store.addApiKey("hp_good", "");
    const mw = createWhitelistMiddleware(store);
    expect(
      isWhitelisted(
        await run(mw, { ip: "1.1.1.1", headers: { "x-api-key": "hp_good" } }),
      ),
    ).toBe(true);
    expect(
      isWhitelisted(
        await run(mw, { ip: "1.1.1.1", headers: { "x-api-key": "hp_bad" } }),
      ),
    ).toBe(false);
    expect(
      isWhitelisted(
        await run(mw, { ip: "1.1.1.1", headers: { "x-api-key": ["hp_good"] } }),
      ),
    ).toBe(false);
  });

  it("caches subnets for the TTL and refreshes after expiry or invalidate()", async () => {
    const store = createWhitelistStore(createMemoryRedis());
    const list = vi.spyOn(store, "listSubnets");
    let t = 0;
    const mw = createWhitelistMiddleware(store, {
      cacheTtlMs: 1000,
      now: () => t,
    });

    await run(mw, { ip: "203.0.113.10" });
    await run(mw, { ip: "203.0.113.10" });
    expect(list).toHaveBeenCalledTimes(1);

    await store.addSubnet("203.0.113.0/24", "");
    expect(isWhitelisted(await run(mw, { ip: "203.0.113.10" }))).toBe(false); // still cached
    mw.invalidate();
    expect(isWhitelisted(await run(mw, { ip: "203.0.113.10" }))).toBe(true);

    t = 5000;
    await run(mw, { ip: "203.0.113.10" });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the store errors: no bypass, request still proceeds", async () => {
    const store = createWhitelistStore(createMemoryRedis());
    store.listSubnets = vi.fn().mockRejectedValue(new Error("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const mw = createWhitelistMiddleware(store);

    expect(isWhitelisted(await run(mw, { ip: "203.0.113.10" }))).toBe(false);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe("rate limiter bypass", () => {
  const req = (over = {}) => ({ ip: "9.9.9.9", headers: {}, ...over });
  const res = () => {
    const r = { headers: {}, statusCode: 200, body: null };
    r.setHeader = (k, v) => (r.headers[k] = v);
    r.status = (c) => ((r.statusCode = c), r);
    r.json = (b) => ((r.body = b), r);
    return r;
  };

  it("throttles normal callers past the limit", () => {
    const limiter = createRateLimiter({ max: 2 });
    const r = res();
    for (let i = 0; i < 3; i++) limiter(req(), r, vi.fn());
    expect(r.statusCode).toBe(429);
  });

  it("never throttles a whitelisted caller and sets no rate-limit headers", () => {
    const limiter = createRateLimiter({ max: 1 });
    const next = vi.fn();
    const r = res();
    for (let i = 0; i < 20; i++)
      limiter(req({ bypassRateLimit: true }), r, next);
    expect(next).toHaveBeenCalledTimes(20);
    expect(r.statusCode).toBe(200);
    expect(r.headers).toEqual({});
  });

  it("accepts a custom skip predicate", () => {
    const limiter = createRateLimiter({
      max: 1,
      skip: (r) => r.ip === "1.1.1.1",
    });
    const next = vi.fn();
    for (let i = 0; i < 5; i++) limiter(req({ ip: "1.1.1.1" }), res(), next);
    expect(next).toHaveBeenCalledTimes(5);
  });
});

describe("admin API", () => {
  let server, base, store, mw;
  const TOKEN = "s3cret-admin-token";

  async function start(adminToken) {
    store = createWhitelistStore(createMemoryRedis());
    mw = createWhitelistMiddleware(store);
    const invalidate = vi.spyOn(mw, "invalidate");
    const app = express();
    app.use(express.json());
    app.use(
      "/admin/whitelist",
      createWhitelistAdminRouter({
        store,
        adminToken,
        onChange: () => mw.invalidate(),
      }),
    );
    await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
    base = `http://127.0.0.1:${server.address().port}/admin/whitelist`;
    return invalidate;
  }
  afterEach(() => new Promise((r) => server?.close(r)));

  const call = (path, { method = "GET", body, token = TOKEN } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it("returns 503 when no admin token is configured", async () => {
    await start(undefined);
    expect((await call("")).status).toBe(503);
  });

  it("rejects missing and wrong bearer tokens with 401", async () => {
    await start(TOKEN);
    expect((await call("", { token: null })).status).toBe(401);
    expect((await call("", { token: "wrong" })).status).toBe(401);
  });

  it("manages subnets and notifies on change", async () => {
    const invalidate = await start(TOKEN);
    const bad = await call("/subnets", {
      method: "POST",
      body: { cidr: "nope" },
    });
    expect(bad.status).toBe(400);

    const created = await call("/subnets", {
      method: "POST",
      body: { cidr: "203.0.113.4/24", label: "911" },
    });
    expect(created.status).toBe(201);
    expect(created.body.subnet).toMatchObject({
      cidr: "203.0.113.0/24",
      label: "911",
    });
    expect(invalidate).toHaveBeenCalledTimes(1);

    const listed = await call("");
    expect(listed.body.subnets).toHaveLength(1);

    expect(
      (await call("/subnets", { method: "DELETE", body: { cidr: "bad" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("/subnets", {
          method: "DELETE",
          body: { cidr: "198.51.100.0/24" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("/subnets", {
          method: "DELETE",
          body: { cidr: "203.0.113.0/24" },
        })
      ).status,
    ).toBe(200);
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect((await call("")).body.subnets).toEqual([]);
  });

  it("creates an API key once, works as a bypass, and can be revoked", async () => {
    await start(TOKEN);
    const created = await call("/api-keys", {
      method: "POST",
      body: { label: "CAD" },
    });
    expect(created.status).toBe(201);
    expect(created.body.apiKey).toMatch(/^hp_[0-9a-f]{48}$/);
    expect(await store.hasApiKey(created.body.apiKey)).toBe(true);

    const listed = await call("");
    expect(JSON.stringify(listed.body)).not.toContain(created.body.apiKey);
    expect(listed.body.apiKeys[0].label).toBe("CAD");

    expect((await call("/api-keys/unknown", { method: "DELETE" })).status).toBe(
      404,
    );
    expect(
      (await call(`/api-keys/${created.body.entry.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect(await store.hasApiKey(created.body.apiKey)).toBe(false);
  });

  it("defaults blank labels and tolerates a missing body", async () => {
    await start(TOKEN);
    const r = await call("/api-keys", { method: "POST" });
    expect(r.body.entry.label).toBe("");
  });
});

describe("redis helper", () => {
  afterEach(() => __setRedisForTests(undefined));

  it("reports whether REDIS_URL is configured", () => {
    expect(isRedisConfigured({})).toBe(false);
    expect(isRedisConfigured({ REDIS_URL: "  " })).toBe(false);
    expect(isRedisConfigured({ REDIS_URL: "redis://localhost:6379" })).toBe(
      true,
    );
  });

  it("returns null without REDIS_URL and memoises the result", async () => {
    expect(await getRedis({})).toBeNull();
    expect(await getRedis({ REDIS_URL: "redis://ignored" })).toBeNull(); // memoised
  });

  it("returns an injected client", async () => {
    const fake = createMemoryRedis();
    __setRedisForTests(fake);
    expect(await getRedis({})).toBe(fake);
  });

  it("default client falls back to an in-memory hash when Redis is not configured", async () => {
    __setRedisForTests(null);
    const client = createDefaultRedisClient();
    await client.hset("k", "f", "v");
    expect(await client.hget("k", "f")).toBe("v");
    expect(await client.hgetall("k")).toEqual({ f: "v" });
    expect(await client.hdel("k", "f")).toBe(1);
  });
});

describe("redis helper with REDIS_URL set", () => {
  afterEach(() => {
    vi.doUnmock("ioredis");
    vi.resetModules();
  });

  it("lazily constructs ioredis with the URL, logs client errors, and reuses the instance", async () => {
    const instances = [];
    class FakeRedis {
      constructor(url, opts) {
        this.url = url;
        this.opts = opts;
        this.handlers = {};
        instances.push(this);
      }
      on(evt, fn) {
        this.handlers[evt] = fn;
      }
    }
    vi.doMock("ioredis", () => ({ Redis: FakeRedis }));
    vi.resetModules();
    const { getRedis: fresh } = await import("../server/lib/redis.ts");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = await fresh({ REDIS_URL: "redis://cache:6379" });
    const second = await fresh({ REDIS_URL: "redis://cache:6379" });

    expect(first).toBe(second);
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe("redis://cache:6379");
    expect(instances[0].opts).toMatchObject({ maxRetriesPerRequest: 2 });
    instances[0].handlers.error(new Error("ECONNRESET"));
    expect(err).toHaveBeenCalledWith("[redis] error:", "ECONNRESET");
    err.mockRestore();
  });
});

describe("express-rate-limit limiters honour the whitelist", () => {
  let server;
  afterEach(() => new Promise((r) => server?.close(r)));

  async function boot() {
    const { proverLimiter } =
      await import("../server/middleware/rateLimiter.ts");
    const app = express();
    // Stand-in for createWhitelistMiddleware: flag callers presenting a header.
    app.use((req, _res, next) => {
      if (req.headers["x-test-whitelisted"]) req.bypassRateLimit = true;
      next();
    });
    app.use(proverLimiter);
    app.get("/", (_req, res) => res.json({ ok: true }));
    await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
    return `http://127.0.0.1:${server.address().port}/`;
  }

  it("returns 429 to normal callers after the limit but never to whitelisted ones", async () => {
    const url = await boot();
    const statuses = [];
    for (let i = 0; i < 12; i++)
      statuses.push(
        (await fetch(url, { headers: { "x-test-whitelisted": "1" } })).status,
      );
    expect(statuses.every((s) => s === 200)).toBe(true);

    const normal = [];
    for (let i = 0; i < 12; i++) normal.push((await fetch(url)).status);
    expect(normal.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(normal.slice(10)).toEqual([429, 429]);
  });
});
