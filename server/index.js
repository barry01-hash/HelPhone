import cluster from "node:cluster";
import express from "express";
import compression from "compression";
import { readFileSync } from "fs";
import { availableParallelism, cpus } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { rpc } from "@stellar/stellar-sdk";

import { normalizeBase64 } from "./base64Utils.js";
import { compression as brotliCompression } from "./middleware/compression.js";
import { logger, poolMonitorMiddleware } from "./middleware/logger.js";
import { createCorsMiddleware } from "./middleware/cors.js";
import { applyKeepAliveTuning, keepAliveMiddleware } from "./middleware/keepAlive.js";
import { getPool } from "./db/connection.js";
import {
  createDefaultRedisClient,
  createWhitelistAdminRouter,
  createWhitelistMiddleware,
  createWhitelistStore,
  isWhitelisted,
} from "./middleware/whitelist.js";
import { startMaintenanceScheduler } from "./db/maintenance.js";
import { getMaintenanceConfig } from "./env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Rate limiter ─────────────────────────────────────────────────────────────
// In-memory sliding-window rate limiter. Tracks request counts per IP within
// a rolling window and returns 429 when the limit is exceeded.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);

export function createRateLimiter({
  windowMs = RATE_LIMIT_WINDOW_MS,
  max = RATE_LIMIT_MAX,
  skip = isWhitelisted,
} = {}) {
  const hits = new Map();

  function cleanup(now) {
    for (const [key, entry] of hits) {
      if (now - entry.start > windowMs) hits.delete(key);
    }
  }

  function middleware(req, res, next) {
    // Whitelisted emergency-service callers bypass throttling entirely.
    if (skip(req)) return next();
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    cleanup(now);

    const entry = hits.get(ip);
    if (!entry || now - entry.start > windowMs) {
      hits.set(ip, { start: now, count: 1 });
    } else {
      entry.count++;
    }

    const current = hits.get(ip);
    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, max - current.count));
    res.setHeader(
      "X-RateLimit-Reset",
      new Date(current.start + windowMs).toISOString(),
    );

    if (current.count > max) {
      return res.status(429).json({
        success: false,
        error: "Too many requests. Please try again later.",
      });
    }
    next();
  }

  // Expose for testing: reset internal state
  middleware._reset = () => hits.clear();
  return middleware;
}

// ── Custom error handler ─────────────────────────────────────────────────────
// Formats all unhandled errors into a consistent JSON envelope so the client
// always receives a parseable response, never an HTML stack trace.
export function errorHandler(err, _req, res, _next) {
  const status = err.status || err.statusCode || 500;
  const message =
    process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message || "Internal server error";

  console.error(`[error] ${status}: ${message}`);
  res.status(status).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV !== "production" && err.stack
      ? { stack: err.stack }
      : {}),
  });
}

export const app = express();
const PORT = process.env.PORT || 3001;

function workerCount() {
  const configured = Number(process.env.WEB_CONCURRENCY);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : Math.max(1, availableParallelism());
}

// Performance: Brotli & Gzip dynamic compression (threshold 1KB, bypass binary assets)
// Uses custom middleware (shrink-ray-current / zlib) — falls back to generic if needed
app.use(
  brotliCompression({
    threshold: 1024,
    debug: process.env.DEBUG_COMPRESSION === "true",
  }),
);
// Observability: structured logger + pool monitoring
// Reuse TCP sockets across sequential requests (see middleware/keepAlive.js)
app.use(keepAliveMiddleware());
app.use(logger({ slowThresholdMs: 1000 }));
app.use(poolMonitorMiddleware);

// Solves Issue 1: Restrict CORS policy — stateful regex validation + 24h preflight cache (Access-Control-Max-Age: 86400)
app.use(createCorsMiddleware());
app.use(compression());
app.use(express.json({ limit: "1mb" }));

// Behind a proxy (Render), req.ip is the proxy unless TRUST_PROXY is set to the
// number of hops (e.g. "1"); whitelist matching and rate limiting both use it.
if (process.env.TRUST_PROXY) {
  const hops = Number(process.env.TRUST_PROXY);
  app.set("trust proxy", Number.isNaN(hops) ? process.env.TRUST_PROXY : hops);
}

// Whitelist of verified emergency-service subnets / API keys (Redis-backed
// when REDIS_URL is set). Must run before the rate limiter, which honours it.
export const whitelistStore = createWhitelistStore(createDefaultRedisClient());
const whitelist = createWhitelistMiddleware(whitelistStore);
app.use(whitelist);
app.use(
  "/admin/whitelist",
  createWhitelistAdminRouter({
    store: whitelistStore,
    adminToken: process.env.WHITELIST_ADMIN_TOKEN,
    onChange: () => whitelist.invalidate(),
  }),
);

// Rate limiter on all routes (disabled in test)
if (process.env.NODE_ENV !== "test") {
  const rateLimiter = createRateLimiter();
  app.use(rateLimiter);
}

// ── Contract event bridge ────────────────────────────────────────
// Issue #177: the frontend used to poll the contract directly on a timer
// (one RPC round-trip per connected browser, every few seconds). Instead,
// this server polls Soroban RPC's getEvents ONCE on an interval — no true
// push exists at the Soroban RPC layer, so this is the honest mechanism —
// and re-broadcasts new events to every connected browser over SSE. That
// turns N client-side polls into 1 server-side poll + fan-out.
const CONTRACT_ID =
  process.env.HELPHONE_CONTRACT_ID ||
  "CDP5XZ7UYCGSQBYRDYM2OEAUQJULBZPULSQXK7LGNAJTRXRG3VHZLSHY";
const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const EVENT_POLL_MS = Number(process.env.EVENT_POLL_MS || 2000);
// Topics published by contract/contracts/helphone-contract/src/lib.rs.
const REQUEST_LIFECYCLE_TOPICS = new Set([
  "RqCreated",
  "RqAcptd",
  "LocUpd",
  "Arrived",
  "Resolved",
  "Cancelled",
]);

const rpcServer = new rpc.Server(RPC_URL, {
  allowHttp: RPC_URL.startsWith("http://"),
});
const sseClients = new Set();
let eventCursor = null; // Soroban RPC pagination cursor; null until first poll seeds it

function decodeTopicSymbol(topicScVal) {
  try {
    return topicScVal?.sym?.() ? topicScVal.sym().toString() : null;
  } catch {
    return null;
  }
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

async function seedCursor() {
  const latest = await rpcServer.getLatestLedger();
  // Soroban RPC only retains a bounded recent-event window; start a few
  // ledgers back so we don't miss events from just before boot.
  return Math.max(1, latest.sequence - 100);
}

async function pollContractEvents() {
  try {
    if (eventCursor === null) {
      eventCursor = await seedCursor();
    }
    const res = await rpcServer.getEvents({
      startLedger: eventCursor,
      filters: [{ type: "contract", contractIds: [CONTRACT_ID] }],
      limit: 100,
    });
    for (const ev of res.events || []) {
      const topic = decodeTopicSymbol(ev.topic?.[0]);
      if (topic && REQUEST_LIFECYCLE_TOPICS.has(topic)) {
        broadcast({ topic, ledger: ev.ledger, id: ev.id });
      }
    }
    if (typeof res.latestLedger === "number") {
      eventCursor = res.latestLedger + 1;
    }
  } catch (err) {
    // A single failed poll must not kill the loop or drop the cursor —
    // just retry next tick. Log so operators can notice sustained failure.
    console.error("[events] poll failed:", err.message || err);
  }
}

app.get("/events/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("retry: 3000\n\n");
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

if (process.env.NODE_ENV !== "test") {
  setInterval(pollContractEvents, EVENT_POLL_MS);
}

let _noir = null;
let _backend = null;
let _ready = false;
let _readyPromise = null;

async function ensureProver() {
  if (_ready) return;
  if (!_readyPromise) {
    _readyPromise = initProver();
  }
  return _readyPromise;
}

async function initProver() {
  const { Noir } = await import("@noir-lang/noir_js");
  const { UltraHonkBackend } = await import("@aztec/bb.js");

  const circuitPath = join(__dirname, "..", "circuits", "target", "aegis.json");
  const circuit = JSON.parse(readFileSync(circuitPath, "utf-8"));
  circuit.bytecode = normalizeBase64(circuit.bytecode);

  _noir = new Noir(circuit);
  _backend = new UltraHonkBackend(circuit.bytecode, {
    threads: Math.max(1, cpus().length - 1),
  });

  console.log("[prover] Warming CRS...");
  await _backend.instantiate();
  _ready = true;
  console.log("[prover] Ready");
}

function health(_req, res) {
  let poolStats = null;
  try {
    poolStats = getPool().getStats();
  } catch {}
  res.json({
    status: _ready ? "ready" : "warming",
    ready: _ready,
    pool: poolStats,
    compression: { threshold: 1024, encodings: ["br", "gzip"] },
  });
}

app.get("/health", health);
app.get("/zk/health", health);

// Pool observability: GET /health/pool exposes detailed pool stats
app.get("/health/pool", (req, res) => {
  try {
    const stats = getPool().monitor();
    res.json({ ok: true, pool: stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/zk/prove", async (req, res) => {
  try {
    const { inputs } = req.body;
    if (!inputs) {
      return res.status(400).json({ success: false, error: "Missing inputs" });
    }

    await ensureProver();
    const start = Date.now();

    const { witness, returnValue } = await _noir.execute(inputs);
    const proofResult = await _backend.generateProof(witness);
    const { proof } = proofResult;

    const nullifier =
      typeof returnValue === "string" ? returnValue : String(returnValue);

    console.log(
      `[prover] Proof generated in ${((Date.now() - start) / 1000).toFixed(1)}s`,
    );

    res.json({
      success: true,
      proof: Buffer.from(proof).toString("hex"),
      nullifier,
    });
  } catch (err) {
    console.error("[prover] Error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Ranking API ─────────────────────────────────────────────────
// Issue #151: Expose ranking data through the server so period filtering
// can be applied. Currently the contract returns all-time rankings only;
// when the contract adds per-period data, the server can pass the period
// through to the contract call.
const RANKING_CACHE_TTL = 30_000;
let _rankingCache = null;
let _rankingCacheTime = 0;

async function fetchRankingFromContract() {
  const now = Date.now();
  if (_rankingCache && now - _rankingCacheTime < RANKING_CACHE_TTL) {
    return _rankingCache;
  }
  const {
    Contract,
    TransactionBuilder,
    Operation,
    rpc,
    Networks,
    Keypair,
    Account,
    BASE_FEE,
    scValToNative,
  } = await import("@stellar/stellar-sdk");
  const serverRpc = new rpc.Server(RPC_URL, {
    allowHttp: RPC_URL.startsWith("http://"),
  });
  const sourceAddress = Keypair.random().publicKey();
  const source = new Account(sourceAddress, "0");
  const sorobanContract = new Contract(CONTRACT_ID);
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(sorobanContract.call("get_ranking"))
    .setTimeout(30)
    .build();
  const sim = await serverRpc.simulateTransaction(tx);
  if (!sim.result) return [];
  const raw = scValToNative(sim.result.retval);
  const entries = Array.isArray(raw) ? raw : [];
  _rankingCache = entries;
  _rankingCacheTime = now;
  return entries;
}

app.get("/api/ranking", async (req, res) => {
  try {
    const { period = "All Time", limit = "50" } = req.query;
    const maxLimit = Math.min(Math.max(1, parseInt(limit, 10) || 50), 200);
    const entries = await fetchRankingFromContract();
    const sorted = entries
      .filter(
        (e) =>
          e &&
          typeof e.responder === "string" &&
          Number.isFinite(e.total_arrivals),
      )
      .sort((a, b) => b.total_arrivals - a.total_arrivals)
      .slice(0, maxLimit);
    res.json({ period, entries: sorted });
  } catch (err) {
    console.error("[ranking] Error:", err.message || err);
    res.status(500).json({ error: "Failed to fetch ranking" });
  }
});

// ── User preferences API (#137) ─────────────────────────────────
// Preferences are stored in memory keyed by Stellar wallet address.
// On login the client fetches them here and applies them; on change the
// client posts back. Falls back to localStorage when unauthenticated.
const preferencesStore = new Map();

const ALLOWED_PREF_KEYS = new Set([
  "nickname",
  "contact",
  "gender",
  "mapStyleIndex",
  "selectedChar",
  "notificationsEnabled",
  "language",
]);

function sanitizePreferences(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const clean = {};
  for (const key of ALLOWED_PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      clean[key] = raw[key];
    }
  }
  return clean;
}

function isValidStellarAddress(addr) {
  return typeof addr === "string" && /^G[A-Z2-7]{55}$/.test(addr);
}

app.get("/api/preferences/:address", (req, res) => {
  const { address } = req.params;
  if (!isValidStellarAddress(address)) {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }
  const prefs = preferencesStore.get(address) || {};
  res.json({ address, preferences: prefs });
});

app.post("/api/preferences/:address", (req, res) => {
  const { address } = req.params;
  if (!isValidStellarAddress(address)) {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }
  const incoming = sanitizePreferences(req.body);
  const existing = preferencesStore.get(address) || {};
  const merged = { ...existing, ...incoming };
  preferencesStore.set(address, merged);
  res.json({ address, preferences: merged });
});

// ── Feedback / rating API (#139) ─────────────────────────────────
// Stores post-resolution ratings (1-5 stars + optional comment) keyed
// by requestId. Feeds into the reputation system when contract integration
// is available; for now the data is queryable by the ranking endpoint.
const feedbackStore = new Map();

app.post("/api/feedback", (req, res) => {
  const { requestId, responderAddress, rating, comment } = req.body;
  if (!Number.isFinite(Number(requestId))) {
    return res.status(400).json({ error: "Missing or invalid requestId" });
  }
  const ratingNum = Number(rating);
  if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: "rating must be 1–5" });
  }
  const entry = {
    requestId: Number(requestId),
    responderAddress: isValidStellarAddress(responderAddress)
      ? responderAddress
      : null,
    rating: Math.round(ratingNum),
    comment: typeof comment === "string" ? comment.slice(0, 500) : "",
    createdAt: new Date().toISOString(),
  };
  feedbackStore.set(Number(requestId), entry);
  console.log(`[feedback] req=${requestId} rating=${entry.rating}`);
  res.json({ success: true, entry });
});

app.get("/api/feedback/:requestId", (req, res) => {
  const id = Number(req.params.requestId);
  if (!Number.isFinite(id))
    return res.status(400).json({ error: "Invalid requestId" });
  const entry = feedbackStore.get(id);
  if (!entry) return res.status(404).json({ error: "Not found" });
  res.json(entry);
});

// ── Soroban Footprint Inspection (#517) ────────────────────────────────
// Mirror of the server/index.ts endpoint: inspects a contract function's
// storage footprint via an RPC simulateTransaction call so clients can build
// envelopes with the required read-only / read-write ledger keys pre-attached.
app.post("/api/soroban/footprint/inspect", async (req, res) => {
  try {
    const { contractId, functionName, args = [] } = req.body || {};
    if (typeof contractId !== "string" || !contractId)
      return res.status(400).json({ success: false, error: "contractId is required" });
    if (typeof functionName !== "string" || !functionName)
      return res.status(400).json({ success: false, error: "functionName is required" });

    const { Account, Keypair, BASE_FEE, Networks, TransactionBuilder, Operation, nativeToScVal, SorobanDataBuilder } = await import("@stellar/stellar-sdk");
    const simServer = new rpc.Server(
      process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
      { timeout: 30_000 },
    );
    const source = new Account(Keypair.random().publicKey(), "0");
    const probe = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: process.env.SOROBAN_NETWORK_PASSPHRASE || Networks.TESTNET,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: functionName,
          args: args.map((arg) =>
            arg && typeof arg === "object" && arg.type && "value" in arg
              ? nativeToScVal(arg.value, { type: arg.type })
              : nativeToScVal(arg),
          ),
        }),
      )
      .setTimeout(30)
      .build();

    const sim = await simServer.simulateTransaction(probe);
    if (sim?.error) {
      return res.status(422).json({ success: false, error: String(sim.error) });
    }

    let builder;
    if (typeof sim?.transactionData === "string") {
      builder = new SorobanDataBuilder(sim.transactionData);
    } else if (sim?.transactionData?.build) {
      builder = new SorobanDataBuilder(sim.transactionData.build());
    } else {
      builder = new SorobanDataBuilder();
    }

    const readOnly = builder.getReadOnly();
    const readWrite = builder.getReadWrite();
    res.json({
      success: true,
      template: {
        contractId,
        functionName,
        readOnlyCount: readOnly.length,
        readWriteCount: readWrite.length,
        resourceFee: String(sim?.minResourceFee ?? "0"),
        footprintXdr: builder.build().toXDR("base64"),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

export function startServer() {
  // Apply schema migrations automatically at boot so the database schema
  // stays in sync on every deploy (non-fatal; server serves even on failure).
  import("./db/migrator.js")
    .then(({ runMigrationsAtStartup }) => runMigrationsAtStartup())
    .catch((err) => console.error("[migrate] startup failure:", err));

  return app.listen(PORT, () => {
  const server = app.listen(PORT, () => {
    // Off-peak VACUUM ANALYZE / REINDEX CONCURRENTLY (opt-in: DB_MAINTENANCE_ENABLED=true)
    if (getMaintenanceConfig().enabled) startMaintenanceScheduler();
    console.log(`ZK Prover worker ${process.pid} on http://localhost:${PORT}`);
    ensureProver().catch((err) => console.error("[prover] Init failed:", err));
  });
  applyKeepAliveTuning(server);
  return server;
}

function startCluster() {
  if (process.env.NODE_ENV === "test" || !cluster.isPrimary) {
    startServer();
    return;
  }

  const workers = workerCount();
  console.log(`[cluster] Primary ${process.pid} starting ${workers} workers`);
  for (let i = 0; i < workers; i++) {
    cluster.fork();
  }

  cluster.on("exit", (worker, code, signal) => {
    console.error(
      `[cluster] Worker ${worker.process.pid} exited (${signal || code}); restarting`,
    );
    cluster.fork();
  });
}

const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectRun) {
  startCluster();
}
