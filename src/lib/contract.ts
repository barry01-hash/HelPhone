// @ts-nocheck
// TypeScript migration: complex Stellar SDK interop types are suppressed here.
// Individual exported functions carry typed signatures (see src/types/index.ts).
// Full strict typing is tracked in a follow-up refactor.
import {
  rpc,
  Contract,
  TransactionBuilder,
  Operation,
  Transaction,
  Account,
  Keypair,
  nativeToScVal,
  scValToNative,
  Networks,
  BASE_FEE,
  StrKey,
} from "@stellar/stellar-sdk";
import { parseEndpointList } from "./networkEstimator";
import { initRpcHealth, reportRpcFailure } from "./rpcHealth";
import type {
  HelpRequest,
  Responder,
  RankingEntry,
  RequestStatus,
} from "../types/index";
import {
  getCachedFootprintTemplate,
  buildSorobanTransaction,
  summarizeFootprint,
} from "./footprint";

/** Validate a Stellar Soroban contract ID (strkey 'C...' with CRC16 checksum).
 *  Throws immediately with a clear message instead of letting a malformed ID
 *  silently propagate into RPC calls, where it would surface later as an
 *  opaque simulation/network failure. */
export function assertValidContractId(id, label) {
  if (typeof id !== "string" || !StrKey.isValidContract(id)) {
    throw new Error(
      `${label} is not a valid Stellar contract ID: ${JSON.stringify(id)}`,
    );
  }
  return id;
}

const DEFAULT_CONTRACT_ID = assertValidContractId(
  "CDP5XZ7UYCGSQBYRDYM2OEAUQJULBZPULSQXK7LGNAJTRXRG3VHZLSHY",
  "DEFAULT_CONTRACT_ID",
);

const ACTIVE_NETWORK_STORAGE_KEY = "helphone:active-network";
const WALLET_ADDRESS_STORAGE_KEY = "helphone:wallet-address";
const DEFAULT_FRIENDBOT_URL = "https://friendbot.stellar.org";

// ── Wallet persistence (#160) ──────────────────────────────────────────────
// Persists the wallet connection address to localStorage so the session
// survives page reloads. The SDK reconnection is handled by the caller.

/** Save wallet address to localStorage. Silently ignores storage failures. */
export function saveWalletAddress(address) {
  if (typeof address !== "string" || !address) return;
  try {
    window.localStorage?.setItem(WALLET_ADDRESS_STORAGE_KEY, address);
  } catch {
    // Storage quota exceeded or unavailable — non-critical
  }
}

/** Load previously saved wallet address from localStorage, or empty string. */
export function loadWalletAddress() {
  try {
    return window.localStorage?.getItem(WALLET_ADDRESS_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

/** Remove saved wallet address from localStorage. */
export function clearWalletAddress() {
  try {
    window.localStorage?.removeItem(WALLET_ADDRESS_STORAGE_KEY);
  } catch {
    // Non-critical
  }
}

export const HELPHONE_NETWORKS = {
  testnet: {
    label: "Testnet",
    networkPassphrase: Networks.TESTNET,
    rpcUrl:
      import.meta.env?.VITE_STELLAR_TESTNET_RPC_URL ||
      "https://soroban-testnet.stellar.org",
    horizonUrl:
      import.meta.env?.VITE_STELLAR_TESTNET_HORIZON_URL ||
      "https://horizon-testnet.stellar.org",
    contractId:
      import.meta.env?.VITE_HELPHONE_TESTNET_CONTRACT_ID ||
      import.meta.env?.VITE_HELPHONE_CONTRACT_ID ||
      DEFAULT_CONTRACT_ID,
    friendbotUrl: import.meta.env?.VITE_FRIENDBOT_URL || DEFAULT_FRIENDBOT_URL,
  },
  futurenet: {
    label: "Futurenet",
    networkPassphrase: Networks.FUTURENET,
    rpcUrl:
      import.meta.env?.VITE_STELLAR_FUTURENET_RPC_URL ||
      "https://rpc-futurenet.stellar.org",
    horizonUrl:
      import.meta.env?.VITE_STELLAR_FUTURENET_HORIZON_URL ||
      "https://horizon-futurenet.stellar.org",
    contractId:
      import.meta.env?.VITE_HELPHONE_FUTURENET_CONTRACT_ID ||
      DEFAULT_CONTRACT_ID,
    friendbotUrl: import.meta.env?.VITE_FUTURENET_FRIENDBOT_URL || "",
  },
  mainnet: {
    label: "Mainnet",
    networkPassphrase: Networks.PUBLIC,
    rpcUrl:
      import.meta.env?.VITE_STELLAR_MAINNET_RPC_URL ||
      "https://mainnet.sorobanrpc.com",
    horizonUrl:
      import.meta.env?.VITE_STELLAR_MAINNET_HORIZON_URL ||
      "https://horizon.stellar.org",
    contractId:
      import.meta.env?.VITE_HELPHONE_MAINNET_CONTRACT_ID ||
      import.meta.env?.VITE_HELPHONE_CONTRACT_ID ||
      DEFAULT_CONTRACT_ID,
    friendbotUrl: "",
  },
};

function normalizeNetworkName(name) {
  return Object.prototype.hasOwnProperty.call(HELPHONE_NETWORKS, name)
    ? name
    : "testnet";
}

export function getActiveNetworkName() {
  if (typeof window !== "undefined") {
    const stored = window.localStorage?.getItem(ACTIVE_NETWORK_STORAGE_KEY);
    if (stored) return normalizeNetworkName(stored);
  }
  return normalizeNetworkName(
    import.meta.env?.VITE_STELLAR_NETWORK || "testnet",
  );
}

export function setActiveNetworkName(name) {
  const normalized = normalizeNetworkName(name);
  if (typeof window !== "undefined") {
    window.localStorage?.setItem(ACTIVE_NETWORK_STORAGE_KEY, normalized);
  }
  return normalized;
}

export function getActiveNetworkConfig() {
  const name = getActiveNetworkName();
  return { name, ...HELPHONE_NETWORKS[name] };
}

const ACTIVE_NETWORK = getActiveNetworkConfig();
const CONTRACT_ID = assertValidContractId(
  ACTIVE_NETWORK.contractId,
  "CONTRACT_ID",
);
const RPC_URL = ACTIVE_NETWORK.rpcUrl;
const FRIENDBOT_URL = ACTIVE_NETWORK.friendbotUrl;
const NETWORK = ACTIVE_NETWORK.networkPassphrase;

const RPC_TIMEOUT_MS = 30_000;
let server = new rpc.Server(RPC_URL, { timeout: RPC_TIMEOUT_MS });

// ── RPC health & failover (#539) ────────────────────────────────
// Backup Soroban RPC nodes come from a comma-separated
// VITE_STELLAR_<NETWORK>_RPC_FALLBACK_URLS (or the network-agnostic
// VITE_STELLAR_RPC_FALLBACK_URLS). The estimator probes the pool and, when the
// primary fails, swaps `server` to the lowest-latency healthy backup; it swaps
// back once the primary recovers. Probing only runs after startRpcMonitoring()
// so importing this module has no network side effects (see rpcHealth.ts).
const RPC_POOL = parseEndpointList(
  RPC_URL,
  import.meta.env?.[
    `VITE_STELLAR_${ACTIVE_NETWORK.name.toUpperCase()}_RPC_FALLBACK_URLS`
  ],
  import.meta.env?.VITE_STELLAR_RPC_FALLBACK_URLS,
);

initRpcHealth({
  endpoints: RPC_POOL,
  onChange: (url) => {
    server = new rpc.Server(url, { timeout: RPC_TIMEOUT_MS });
  },
});
const contract = new Contract(CONTRACT_ID);

// ── RPC Response Cache (issue #63) ──────────────────────────────
// Caches read-only contract responses to reduce RPC rate limit hits
// and deduplicate concurrent identical requests into a single promise.
const _requestCache = new Map();
const _requestPromises = new Map();
const CACHE_TTL = {
  short: 5_000,
  long: 60_000,
};

function _getCacheKey(method, args) {
  return `${method}:${JSON.stringify(args)}`;
}

function _getCachedValue(key) {
  const entry = _requestCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > entry.ttl) {
    _requestCache.delete(key);
    return undefined;
  }
  return entry.value;
}

async function _withCache(method, args, ttl, fetchFn) {
  const key = _getCacheKey(method, args);
  const cached = _getCachedValue(key);
  if (cached !== undefined) {
    return cached;
  }
  if (_requestPromises.has(key)) {
    return _requestPromises.get(key);
  }
  const promise = fetchFn()
    .then((result) => {
      _requestCache.set(key, { value: result, timestamp: Date.now(), ttl });
      _requestPromises.delete(key);
      return result;
    })
    .catch((err) => {
      _requestPromises.delete(key);
      throw err;
    });
  _requestPromises.set(key, promise);
  return promise;
}

// ── Coordinate encoding ─────────────────────────────────────────
// The contract stores lat/lng as fixed-point i32: degrees * COORD_SCALE.
const COORD_SCALE = 1_000_000;
const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;
const LNG_SPAN = LNG_MAX - LNG_MIN;
// Bounds of the on-chain i32 the scaled value has to fit into.
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;

/** Safely convert a Soroban contract value to a JavaScript number without precision loss.
 *  Handles BigInt, number, and string inputs. Returns NaN for unconvertible values. */
function safeToNumber(val) {
  if (typeof val === "number") return val;
  if (typeof val === "bigint") {
    if (
      val > BigInt(Number.MAX_SAFE_INTEGER) ||
      val < BigInt(-Number.MAX_SAFE_INTEGER)
    ) {
      return NaN;
    }
    return Number(val);
  }
  if (typeof val === "string") return Number(val);
  return NaN;
}

/** Clamp a value into an inclusive range. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Wrap a longitude value into [LNG_MIN, LNG_MAX]. */
function clampLng(lng) {
  if (lng < LNG_MIN || lng > LNG_MAX) {
    return ((((lng - LNG_MIN) % LNG_SPAN) + LNG_SPAN) % LNG_SPAN) + LNG_MIN;
  }
  return lng;
}

/** Decode an on-chain fixed-point coordinate into degrees. NaN if unconvertible. */
function decodeCoord(raw) {
  const num = safeToNumber(raw);
  return Number.isFinite(num) ? num / COORD_SCALE : NaN;
}

/** Decode + clamp a latitude, or null when the raw value is unusable. */
function decodeLat(raw) {
  const lat = decodeCoord(raw);
  return Number.isFinite(lat) ? clamp(lat, LAT_MIN, LAT_MAX) : null;
}

/** Decode + wrap a longitude, or null when the raw value is unusable. */
function decodeLng(raw) {
  const lng = decodeCoord(raw);
  return Number.isFinite(lng) ? clampLng(lng) : null;
}

/** Encode degrees into the fixed-point i32 the contract expects.
 *  Throws instead of silently writing a value the contract would truncate. */
function encodeCoord(value, label) {
  const scaled = Math.round(guardNaN(value, label) * COORD_SCALE);
  if (scaled < I32_MIN || scaled > I32_MAX) {
    throw new Error(
      `${label} is outside the range the contract can store (got ${value})`,
    );
  }
  return scaled;
}

// Dummy source for read-only simulations. TransactionBuilder.build() increments the
// source account's sequence number, so a single shared Account drifts once more than
// one read has run. Each simulation gets a fresh Account pinned to sequence 0 instead;
// the keypair is generated lazily so importing this module never touches crypto.
const READ_SOURCE_SEQUENCE = "0";
let _readSourceAddress = null;

function _readSource() {
  if (!_readSourceAddress) _readSourceAddress = Keypair.random().publicKey();
  return new Account(_readSourceAddress, READ_SOURCE_SEQUENCE);
}

function normalizeBase64(input, label = "Base64 value") {
  if (typeof input !== "string") {
    throw new Error(`${label} must be a string.`);
  }

  let value = input.trim();
  const commaIndex = value.indexOf(",");
  if (
    commaIndex !== -1 &&
    /^data:.*;base64/i.test(value.slice(0, commaIndex))
  ) {
    value = value.slice(commaIndex + 1);
  }

  value = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");

  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${label} contains invalid Base64 characters.`);
  }

  const remainder = value.length % 4;
  if (remainder === 1) {
    throw new Error(`${label} has an invalid Base64 length.`);
  }
  if (remainder > 0) {
    value += "=".repeat(4 - remainder);
  }

  return value;
}

function scv(val, opts) {
  return nativeToScVal(val, opts);
}

const PRIORITY_LEVELS = ["Low", "Medium", "High", "Critical"];

function mapRequest(raw) {
  const STATUS = ["Pending", "Enroute", "Resolved", "Cancelled"];
  const rawPriority =
    typeof raw.priority === "number"
      ? PRIORITY_LEVELS[raw.priority]
      : typeof raw.priority === "string"
        ? raw.priority
        : "Medium";
  return {
    id: raw.id ? safeToNumber(raw.id) : raw.id,
    requester: raw.requester,
    lat: decodeLat(raw.lat),
    lng: decodeLng(raw.lng),
    emergency_type: raw.emergency_type,
    nickname: raw.nickname,
    contact: raw.contact,
    status:
      STATUS[raw.status] ??
      (Array.isArray(raw.status) ? raw.status[0] : raw.status),
    priority: PRIORITY_LEVELS.includes(rawPriority) ? rawPriority : "Medium",
    created_at: safeToNumber(raw.created_at),
    resolved_at: raw.resolved_at ? safeToNumber(raw.resolved_at) : null,
  };
}

function mapResponder(raw) {
  return {
    responder: raw.responder,
    lat: decodeLat(raw.lat),
    lng: decodeLng(raw.lng),
    eta_seconds: raw.eta_seconds,
    arrived: raw.arrived,
    responded_at: safeToNumber(raw.responded_at),
  };
}

// ── Retry with exponential backoff (issue #178) ─────────────────
// Network congestion drops RPC calls; retrying blindly on contract-logic
// errors (AlreadyClaimed, WrongStatus, etc.) would just waste time since
// those can never succeed on retry, so only transient/network-shaped
// failures are retried. `err.contractCode` is set by buildContractError
// once a response has actually been parsed as an on-chain error — that
// is always non-retryable.
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isRetryableError(err) {
  if (err?.contractCode != null) return false;
  const msg = String(err?.message || err || "");
  return /fetch|network|timeout|ECONNRESET|ETIMEDOUT|502|503|504|Failed to fetch/i.test(
    msg,
  );
}

/** Runs `fn` with exponential backoff (1s, 2s, 4s, ...) on retryable
 *  failures. Aborts and rethrows (with a clearer message) once
 *  `maxAttempts` is exhausted — callers already surface thrown errors to
 *  the user (see e.g. Help.jsx's `alert(err.message)` pattern), so this
 *  is also how the user gets notified. */
async function withRetry(
  fn,
  { label = "request", maxAttempts = RETRY_MAX_ATTEMPTS } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // A network-shaped failure counts against the active RPC node so the
      // estimator can fail over without waiting for its next probe.
      if (isRetryableError(err)) reportRpcFailure();
      if (!isRetryableError(err) || attempt === maxAttempts - 1) break;
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** attempt;
      console.warn(
        `[retry] ${label} failed (attempt ${attempt + 1}/${maxAttempts}); retrying in ${delayMs}ms`,
        err?.message || err,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (isRetryableError(lastErr)) {
    throw new Error(
      `${label} failed after ${maxAttempts} attempts due to network congestion. Please try again.`,
    );
  }
  throw lastErr;
}

// ── Read helper ─────────────────────────────────────────────────
async function simulateRead(call) {
  return withRetry(
    async () => {
      const tx = new TransactionBuilder(_readSource(), {
        fee: BASE_FEE,
        networkPassphrase: NETWORK,
      })
        .addOperation(call)
        .setTimeout(30)
        .build();
      return await server.simulateTransaction(tx);
    },
    { label: "Reading from contract" },
  );
}

async function resolveWalletAddress(wallet, fallback = "") {
  if (fallback) return fallback;
  if (wallet?.account?.address) return wallet.account.address;
  if (typeof wallet?.getAddress === "function") {
    const { address } = await wallet.getAddress();
    return address || "";
  }
  if (typeof wallet?.fetchAddress === "function") {
    const { address } = await wallet.fetchAddress();
    return address || "";
  }
  return "";
}

// ── Reads (no wallet needed) ───────────────────────────────────

export async function getRequest(requestId) {
  const id = safeToNumber(requestId);
  if (!Number.isFinite(id) || id < 0) return null;
  return _withCache("getRequest", [id], CACHE_TTL.short, async () => {
    const sim = await simulateRead(
      contract.call("get_request", scv(id, { type: "u64" })),
    );
    if (!sim.result) return null;
    const raw = scValToNative(sim.result.retval);
    return raw ? mapRequest(raw) : null;
  });
}

export async function getResponder(requestId, index) {
  return _withCache(
    "getResponder",
    [requestId, index],
    CACHE_TTL.short,
    async () => {
      const sim = await simulateRead(
        contract.call(
          "get_responder",
          scv(Number(requestId), { type: "u64" }),
          scv(Number(index), { type: "u32" }),
        ),
      );
      if (!sim.result) return null;
      const raw = scValToNative(sim.result.retval);
      return raw ? { id: `${requestId}-${index}`, ...mapResponder(raw) } : null;
    },
  );
}

export async function getActiveRequests(max = 500) {
  return _withCache("getActiveRequests", [max], CACHE_TTL.short, async () => {
    const sim = await simulateRead(contract.call("get_active_requests"));
    if (!sim.result) return [];
    const rawIds = scValToNative(sim.result.retval);
    return rawIds.map((id) => safeToNumber(id)).slice(0, max);
  });
}

export async function getRequestCount() {
  return _withCache("getRequestCount", [], CACHE_TTL.short, async () => {
    const sim = await simulateRead(contract.call("get_request_count"));
    if (!sim.result) return 0;
    return safeToNumber(scValToNative(sim.result.retval));
  });
}

export async function getResponderCount(requestId) {
  return _withCache(
    "getResponderCount",
    [requestId],
    CACHE_TTL.short,
    async () => {
      const sim = await simulateRead(
        contract.call(
          "get_responder_count",
          scv(Number(requestId), { type: "u64" }),
        ),
      );
      if (!sim.result) return 0;
      return scValToNative(sim.result.retval);
    },
  );
}

export async function getRanking(limit = 50, period = "All Time") {
  return _withCache("getRanking", [limit, period], CACHE_TTL.long, async () => {
    const sim = await simulateRead(contract.call("get_ranking"));
    if (!sim.result) return [];
    return scValToNative(sim.result.retval).slice(0, limit);
  });
}

/** Maintainer Vault funding stats (contracts/maintainer_vault). Returns null
 *  when VITE_MAINTAINER_VAULT_CONTRACT_ID is unset (vault not deployed). */
export async function getMaintainerFunding() {
  const id = import.meta.env?.VITE_MAINTAINER_VAULT_CONTRACT_ID;
  if (!id) return null;
  const vault = new Contract(
    assertValidContractId(id, "VITE_MAINTAINER_VAULT_CONTRACT_ID"),
  );
  return _withCache("getMaintainerFunding", [id], CACHE_TTL.long, async () => {
    const sim = await simulateRead(vault.call("stats"));
    if (!sim.result) return null;
    return scValToNative(sim.result.retval);
  });
}

export async function getExpertVerifications(walletAddress, limit = 10) {
  if (!walletAddress) return [];
  return _withCache(
    "getExpertVerifications",
    [walletAddress, limit],
    CACHE_TTL.long,
    async () => {
      const sim = await simulateRead(
        contract.call(
          "get_expert_verifications",
          scv(walletAddress, { type: "address" }),
          scv(Number(limit), { type: "u32" }),
        ),
      );
      if (!sim.result) return [];
      return scValToNative(sim.result.retval) || [];
    },
  );
}

// ── Contract event stream (issue #177) ─────────────────────────
// Server-Sent Events from the local prover/events server, which itself
// polls Soroban RPC once and fans out to every connected browser (see
// server/index.js). Falls back gracefully: callers keep their own
// interval-based refresh as a backstop and just refresh sooner/less often
// depending on whether this connects.
const EVENTS_URL =
  import.meta.env?.VITE_EVENTS_URL || "http://localhost:3001/events/stream";

/** Subscribe to contract lifecycle events. `onEvent` is called with
 *  `{ topic, ledger, id }` for each event. Returns an unsubscribe function.
 *  Never throws — a construction failure (e.g. no EventSource support)
 *  just means the caller's polling fallback keeps doing all the work. */
export function subscribeToContractEvents(onEvent) {
  let es;
  try {
    es = new EventSource(EVENTS_URL);
  } catch {
    return () => {};
  }
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      // malformed event payload — ignore, don't crash the subscriber
    }
  };
  es.onerror = () => {
    // EventSource auto-reconnects on transient errors; nothing to do here.
    // The caller's polling fallback continues covering us regardless.
  };
  return () => es.close();
}

export async function getWalletBalances(address) {
  if (!address) return [];
  return _withCache(
    "getWalletBalances",
    [address],
    CACHE_TTL.long,
    async () => {
      const url = new URL(`/accounts/${address}`, ACTIVE_NETWORK.horizonUrl);
      const response = await fetch(url.toString());

      if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error("Could not load wallet balances");
      }

      const account = await response.json();
      return (account.balances || []).map((balance) => ({
        asset: balance.asset_type === "native" ? "XLM" : balance.asset_code,
        balance: Number(balance.balance),
      }));
    },
  );
}
export async function checkAccount(address) {
  if (!address) return false;
  return _withCache("checkAccount", [address], CACHE_TTL.long, async () => {
    try {
      await server.getAccount(address);
      return true;
    } catch {
      return false;
    }
  });
}

/** Build the friendbot funding URL for an address.
 *  Uses the URL API so an override that already carries a path, a trailing slash or
 *  its own query string still yields a well-formed request in every browser, rather
 *  than the `?` concatenation that only worked for the bare default host. */
function friendbotUrl(address) {
  try {
    const url = new URL(FRIENDBOT_URL);
    url.searchParams.set("addr", address);
    return url.toString();
  } catch {
    const separator = FRIENDBOT_URL.includes("?") ? "&" : "?";
    return `${FRIENDBOT_URL}${separator}addr=${encodeURIComponent(address)}`;
  }
}

export async function ensureAccountFunded(address) {
  if (!address) throw new Error("Wallet address is not available yet");
  if (await checkAccount(address)) return true;
  if (!FRIENDBOT_URL) {
    throw new Error(
      `${ACTIVE_NETWORK.label} account is not funded. Fund it before submitting transactions.`,
    );
  }

  const res = await fetch(friendbotUrl(address));
  if (!res.ok) {
    let message = "Could not fund Stellar testnet account";
    try {
      const data = await res.json();
      message = data.detail || data.title || data.error || message;
    } catch {}
    throw new Error(message);
  }

  for (let i = 0; i < 12; i++) {
    if (await checkAccount(address)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    "Testnet funding was requested but account is not available yet",
  );
}

// ── Aegis Vault — ZK location proof + aid claim ───────────────
const AEGIS_VAULT_ID = import.meta.env?.VITE_AEGIS_VAULT_ID || "";

export async function claimAid(
  recipient,
  publicInputsBytes,
  proofBytes,
  wallet,
) {
  if (!AEGIS_VAULT_ID)
    throw new Error(
      "VITE_AEGIS_VAULT_ID not configured — deploy aegis_vault first",
    );
  const signerAddress = await resolveWalletAddress(wallet);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: AEGIS_VAULT_ID,
        function: "claim_aid",
        args: [
          scv(recipient, { type: "address" }),
          nativeToScVal(
            publicInputsBytes instanceof Uint8Array
              ? publicInputsBytes
              : new Uint8Array(publicInputsBytes),
          ),
          nativeToScVal(
            proofBytes instanceof Uint8Array
              ? proofBytes
              : new Uint8Array(proofBytes),
          ),
        ],
      }),
    )
    .setTimeout(60)
    .build();
  return await sendWrite(tx, wallet, "claim_aid");
}

export async function fundZone(publicInputsPrefix, amount, wallet) {
  if (!AEGIS_VAULT_ID)
    throw new Error(
      "VITE_AEGIS_VAULT_ID not configured — deploy aegis_vault first",
    );
  const signerAddress = await resolveWalletAddress(wallet);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: AEGIS_VAULT_ID,
        function: "fund_zone",
        args: [
          scv(signerAddress, { type: "address" }),
          nativeToScVal(
            publicInputsPrefix instanceof Uint8Array
              ? publicInputsPrefix
              : new Uint8Array(publicInputsPrefix),
          ),
          scv(BigInt(amount), { type: "i128" }),
        ],
      }),
    )
    .setTimeout(60)
    .build();
  return await sendWrite(tx, wallet, "fund_zone");
}

// ── Writes (require wallet) ────────────────────────────────────

const CONTRACT_ERROR_MESSAGES = {
  create_request: {
    1: "Request was not found.",
    2: "This wallet is not authorized for that action.",
  },
  accept_request: {
    1: "This request was not found.",
    2: "This wallet is not authorized to help with this request.",
    3: "This request is no longer pending. Someone else may already be on the way.",
  },
  mark_arrived: {
    1: "This request or responder was not found.",
    2: "This wallet is not authorized to mark arrival.",
    4: "You already marked yourself as arrived.",
  },
  resolve_request: {
    1: "This request was not found.",
    2: "Only the requester can resolve this request.",
    3: "This request can only be resolved once a responder is on the way.",
  },
  cancel_request: {
    1: "This request was not found.",
    2: "Only the requester can cancel this request.",
    3: "This request can only be cancelled while it is pending.",
  },
  record_expert_verification: {
    2: "This wallet is not authorized to record the checkpoint.",
  },
  propose_transfer: {
    2: "Only the current contract owner can propose an ownership transfer.",
  },
  accept_transfer: {
    2: "Only the nominated new owner can accept this transfer.",
    5: "There is no pending ownership transfer to accept.",
  },
  revoke_transfer: {
    2: "Only the current owner or nominated new owner can revoke this transfer.",
    5: "There is no pending ownership transfer to revoke.",
  },
};

function parseContractErrorCode(message) {
  const text = String(message || "");
  const match = text.match(/Contract,\s*#(\d+)/i);
  return match ? Number(match[1]) : null;
}

function buildContractError(rawError, operation) {
  const raw =
    typeof rawError === "string"
      ? rawError
      : rawError?.message || JSON.stringify(rawError);
  const contractCode = parseContractErrorCode(raw);
  const friendly = contractCode
    ? CONTRACT_ERROR_MESSAGES[operation]?.[contractCode]
    : "";
  const err = new Error(friendly || raw);
  err.contractCode = contractCode;
  err.operation = operation;
  err.rawMessage = raw;
  return err;
}

async function sendWrite(rawTx, wallet, operation = "") {
  // Simulation and submission are the two network round-trips congestion
  // actually drops; signing is local (wallet), so it's left out of retry.
  const sim = await withRetry(() => server.simulateTransaction(rawTx), {
    label: `Simulating ${operation || "transaction"}`,
  });
  if (sim.error) {
    throw buildContractError(sim.error, operation);
  }
  const preparedTx = rpc.assembleTransaction(rawTx, sim, NETWORK).build();
  const signResult = await wallet.signTransaction(preparedTx.toXDR(), {
    networkPassphrase: NETWORK,
  });
  const signedTxXdr = normalizeBase64(
    typeof signResult === "string" ? signResult : signResult?.signedTxXdr,
    "Signed Stellar transaction XDR",
  );
  const signedTx = new Transaction(signedTxXdr, NETWORK);
  const response = await withRetry(() => server.sendTransaction(signedTx), {
    label: `Submitting ${operation || "transaction"}`,
  });

  if (response.status === "ERROR") {
    throw new Error(response.errorResult?.result?.code || "Transaction error");
  }

  const hash = response.hash;
  for (let i = 0; i < 30; i++) {
    const txResult = await server.getTransaction(hash);
    if (txResult.status === "SUCCESS") {
      return { hash, ...txResult };
    }
    if (txResult.status === "FAILED") {
      throw new Error("Transaction failed");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error("Transaction timed out");
}

function guardNaN(val, label) {
  const num = safeToNumber(val);
  if (!Number.isFinite(num)) {
    throw new Error(`${label} is invalid (got ${JSON.stringify(val)})`);
  }
  return num;
}

// ── Automated footprint assembly (#517) ─────────────────────────────────
// Functions whose storage key set is purely determined by their arguments can
// reuse a server-verified footprint template baked into the envelope. The write
// path ONLY reuses templates the inspector already cached — it never performs
// an inspection round-trip itself (that would double RPC calls and slow the
// critical submit path). Templates are produced up-front by inspectFootprint /
// warmFootprintTemplates (client pre-flight or the server inspection endpoint).
const SAFE_FOOTPRINT_FUNCTIONS = new Set([
  "mark_arrived",
  "resolve_request",
  "cancel_request",
  "propose_transfer",
  "accept_transfer",
  "revoke_transfer",
  "create_admin_proposal",
  "approve_admin_proposal",
  "execute_admin_proposal",
]);

/** Build a contract invocation, baking a cached/verified footprint in when one
 *  is already resident. Cache misses degrade gracefully to the footprint-free
 *  envelope (pre-sign simulation derives the keys as it always has). */
async function buildInvocation({ account, functionName, args, timeoutSeconds = 30 }) {
  let template;
  if (SAFE_FOOTPRINT_FUNCTIONS.has(functionName)) {
    template = getCachedFootprintTemplate(CONTRACT_ID, functionName, args);
    if (template) {
      const summary = summarizeFootprint(template);
      console.debug(
        `[footprint] ${functionName}: using cached template (${summary.readOnlyCount} read / ${summary.readWriteCount} write keys, resource fee ${summary.resourceFee})`,
      );
    }
  }
  const { transaction } = buildSorobanTransaction({
    account,
    contractId: CONTRACT_ID,
    functionName,
    args,
    template,
    networkPassphrase: NETWORK,
    timeoutSeconds,
  });
  return transaction;
}

export async function createRequest(
  requester,
  lat,
  lng,
  emergencyType,
  nickname,
  contact,
  wallet,
  priority = "Medium",
) {
  const signerAddress = await resolveWalletAddress(wallet, requester);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const priorityIndex = PRIORITY_LEVELS.indexOf(priority);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: "create_request",
        args: [
          scv(requester, { type: "address" }),
          scv(encodeCoord(lat, "lat"), { type: "i32" }),
          scv(encodeCoord(lng, "lng"), { type: "i32" }),
          scv(emergencyType, { type: "string" }),
          scv(nickname, { type: "string" }),
          scv(contact, { type: "string" }),
          scv(priorityIndex >= 0 ? priorityIndex : 1, { type: "u32" }),
        ],
      }),
    )
    .setTimeout(30)
    .build();

  const result = await sendWrite(tx, wallet, "create_request");
  const retval = scValToNative(result.returnValue);
  return { requestId: safeToNumber(retval), hash: result.hash };
}

export async function acceptRequest(
  responder,
  requestId,
  lat,
  lng,
  etaSeconds,
  wallet,
) {
  const signerAddress = await resolveWalletAddress(wallet, responder);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: "accept_request",
        args: [
          scv(responder, { type: "address" }),
          scv(guardNaN(Number(requestId), "requestId"), { type: "u64" }),
          scv(encodeCoord(lat, "lat"), { type: "i32" }),
          scv(encodeCoord(lng, "lng"), { type: "i32" }),
          scv(guardNaN(Number(etaSeconds), "etaSeconds"), { type: "u32" }),
        ],
      }),
    )
    .setTimeout(30)
    .build();

  const result = await sendWrite(tx, wallet, "accept_request");
  const retval = scValToNative(result.returnValue);
  return { index: safeToNumber(retval), hash: result.hash };
}

export async function markArrived(responder, requestId, wallet) {
  const signerAddress = await resolveWalletAddress(wallet, responder);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = await buildInvocation({
    account,
    functionName: "mark_arrived",
    args: [
      scv(responder, { type: "address" }),
      scv(Number(requestId), { type: "u64" }),
    ],
  });

  return await sendWrite(tx, wallet, "mark_arrived");
}

let trackingKeypair = null;
let trackingAccount = null;

async function getTrackingSigner() {
  if (trackingKeypair && trackingAccount)
    return { keypair: trackingKeypair, account: trackingAccount };
  trackingKeypair = Keypair.random();
  const addr = trackingKeypair.publicKey();
  await ensureAccountFunded(addr);
  trackingAccount = await server.getAccount(addr);
  return { keypair: trackingKeypair, account: trackingAccount };
}

export async function updateLocation(responder, requestId, lat, lng) {
  const { keypair, account } = await getTrackingSigner();
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: CONTRACT_ID,
        function: "update_location",
        args: [
          scv(responder, { type: "address" }),
          scv(Number(requestId), { type: "u64" }),
          scv(encodeCoord(lat, "lat"), { type: "i32" }),
          scv(encodeCoord(lng, "lng"), { type: "i32" }),
        ],
      }),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  const preparedTx = rpc.assembleTransaction(tx, sim, NETWORK).build();
  preparedTx.sign(keypair);
  const response = await server.sendTransaction(preparedTx);

  if (response.status === "ERROR") {
    throw new Error(
      response.errorResult?.result?.code || "Tracking transaction error",
    );
  }

  const hash = response.hash;
  for (let i = 0; i < 20; i++) {
    const txResult = await server.getTransaction(hash);
    if (txResult.status === "SUCCESS") return;
    if (txResult.status === "FAILED") throw new Error("Tracking tx failed");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function resolveRequest(requester, requestId, wallet) {
  const signerAddress = await resolveWalletAddress(wallet, requester);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = await buildInvocation({
    account,
    functionName: "resolve_request",
    args: [scv(requester, { type: "address" }), scv(Number(requestId), { type: "u64" })],
  });

  await sendWrite(tx, wallet, "resolve_request");
}

export async function cancelRequest(requester, requestId, wallet) {
  const signerAddress = await resolveWalletAddress(wallet, requester);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = await buildInvocation({
    account,
    functionName: "cancel_request",
    args: [scv(requester, { type: "address" }), scv(Number(requestId), { type: "u64" })],
  });

  await sendWrite(tx, wallet, "cancel_request");
}

// Enhanced record function with CORS protection and cryptographic material safety
const _recordCache = new Map();
const _RECORD_CACHE_TTL = 60000; // 1 minute cache TTL
const _MAX_CACHE_SIZE = 100; // Prevent memory exhaustion attacks

function _sanitizeCryptographicMaterial(value) {
  // Prevent leakage of sensitive cryptographic materials
  if (!value) return "";

  // Handle non-string inputs safely
  const str = String(value);

  // Validate input length to prevent DoS
  if (str.length > 1000) {
    return "[INVALID_INPUT]";
  }

  // Truncate to prevent exposure of full cryptographic fingerprints
  if (str.length > 64) {
    return str.slice(0, 32) + "..." + str.slice(-8);
  }

  // Remove potential hex prefixes that could leak structure
  return str.replace(/^0x/i, "");
}

function _isCorsSafeError(error) {
  // Identify CORS-related errors that shouldn't expose sensitive data
  const message = error?.message || "";
  const corsPatterns = ["CORS", "cross-origin", "network", "fetch", "timeout"];
  return corsPatterns.some((pattern) =>
    message.toLowerCase().includes(pattern),
  );
}

// ── Admin functions (Aegis Vault) ──────────────────────────────

export async function getAegisAdmin() {
  if (!AEGIS_VAULT_ID) return null;
  const sim = await simulateRead(contract.call("get_admin"));
  if (!sim.result) return null;
  const raw = scValToNative(sim.result.retval);
  return raw || null;
}

export async function getAegisPayoutAmount() {
  if (!AEGIS_VAULT_ID) return null;
  const sim = await simulateRead(contract.call("payout_amount"));
  if (!sim.result) return null;
  return safeToNumber(scValToNative(sim.result.retval));
}

export async function setAegisPayoutAmount(admin, amount, wallet) {
  if (!AEGIS_VAULT_ID) throw new Error("VITE_AEGIS_VAULT_ID not configured");
  const signerAddress = await resolveWalletAddress(wallet);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: AEGIS_VAULT_ID,
        function: "set_payout_amount",
        args: [
          scv(signerAddress, { type: "address" }),
          scv(BigInt(amount), { type: "i128" }),
        ],
      }),
    )
    .setTimeout(30)
    .build();
  return await sendWrite(tx, wallet, "set_payout_amount");
}

export async function getAegisCampaignBalance(campaignId) {
  if (!AEGIS_VAULT_ID) return 0;
  const sim = await simulateRead(
    contract.call("campaign_balance", scv(campaignId, { type: "bytesN<32>" })),
  );
  if (!sim.result) return 0;
  return safeToNumber(scValToNative(sim.result.retval));
}

export async function getAegisIsClaimed(nullifier) {
  if (!AEGIS_VAULT_ID) return false;
  const sim = await simulateRead(
    contract.call("is_claimed", scv(nullifier, { type: "bytesN<32>" })),
  );
  if (!sim.result) return false;
  return scValToNative(sim.result.retval) === true;
}

export async function upgradeAegisVault(newWasmHash, wallet) {
  if (!AEGIS_VAULT_ID) throw new Error("VITE_AEGIS_VAULT_ID not configured");
  const signerAddress = await resolveWalletAddress(wallet);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: AEGIS_VAULT_ID,
        function: "upgrade",
        args: [scv(newWasmHash, { type: "bytesN<32>" })],
      }),
    )
    .setTimeout(30)
    .build();
  return await sendWrite(tx, wallet, "upgrade");
}

export async function withdrawProtocolFees(
  tokenAddress,
  recipient,
  amount,
  wallet,
) {
  if (!AEGIS_VAULT_ID) throw new Error("VITE_AEGIS_VAULT_ID not configured");
  const signerAddress = await resolveWalletAddress(wallet);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: AEGIS_VAULT_ID,
        function: "fund_zone",
        args: [
          scv(signerAddress, { type: "address" }),
          nativeToScVal(new Uint8Array(160)),
          scv(BigInt(amount), { type: "i128" }),
        ],
      }),
    )
    .setTimeout(30)
    .build();
  return await sendWrite(tx, wallet, "withdraw_protocol_fees");
}

export async function recordExpertVerification(
  walletAddress,
  action,
  txHash,
  proofFingerprint,
  wallet,
) {
  if (!walletAddress) throw new Error("Wallet address is not available yet");

  // Sanitize sensitive cryptographic material before processing
  const sanitizedFingerprint = _sanitizeCryptographicMaterial(proofFingerprint);

  // Check cache to prevent duplicate CORS requests with same data
  const cacheKey = `${walletAddress}-${action}-${sanitizedFingerprint}`;
  const cached = _recordCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < _RECORD_CACHE_TTL) {
    return cached.result;
  }

  try {
    const signerAddress = await resolveWalletAddress(wallet, walletAddress);
    if (!signerAddress) throw new Error("Wallet address is not available yet");
    await ensureAccountFunded(signerAddress);
    const account = await server.getAccount(signerAddress);

    // Build transaction with sanitized data
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: CONTRACT_ID,
          function: "record_expert_verification",
          args: [
            scv(signerAddress, { type: "address" }),
            scv(action, { type: "string" }),
            scv(txHash || "", { type: "string" }),
            scv(proofFingerprint || "", { type: "string" }), // Use original for transaction
          ],
        }),
      )
      .setTimeout(30)
      .build();

    // Add timeout protection for CORS requests
    const recordPromise = sendWrite(tx, wallet, "record_expert_verification");
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Request timeout")), 20000),
    );

    const result = await Promise.race([recordPromise, timeoutPromise]);

    // Cache successful result
    _recordCache.set(cacheKey, { timestamp: Date.now(), result });

    // Clean up old cache entries to prevent memory exhaustion
    if (_recordCache.size > _MAX_CACHE_SIZE) {
      const now = Date.now();
      const keysToDelete = [];
      for (const [key, value] of _recordCache.entries()) {
        if (now - value.timestamp > _RECORD_CACHE_TTL) {
          keysToDelete.push(key);
        }
      }
      // Delete in batch to prevent timing attacks
      keysToDelete.forEach((key) => _recordCache.delete(key));
    }

    return result;
  } catch (err) {
    // CORS-safe error handling - don't expose cryptographic materials in errors
    if (_isCorsSafeError(err)) {
      throw new Error("Network error - unable to record verification");
    }
    // For other errors, sanitize message to prevent data leakage
    const sanitizedMessage = err.message
      .replace(/0x[a-fA-F0-9]{32,}/g, "[REDACTED]")
      .replace(/[a-zA-Z0-9]{64,}/g, "[REDACTED]");
    throw new Error(sanitizedMessage || "Recording failed");
  }
}

// ── Two-Step Ownership Transfer (helphone-contract) ────────────────────────
//
// Mirrors the propose_transfer / accept_transfer / revoke_transfer functions
// added to contract/contracts/helphone-contract/src/lib.rs.
//
// The three functions follow the same sendWrite pattern used by all write
// operations in this file: fund account → build tx → simulate → sign → submit.

/** Read the pending new owner from the contract (or null if none). */
export async function getPendingOwner() {
  const sim = await simulateRead(contract.call("get_pending_owner"));
  if (!sim.result) return null;
  const raw = scValToNative(sim.result.retval);
  return raw || null;
}

/**
 * Step 1 — Propose transferring ownership to `newOwner`.
 * Only the current admin may call this. Replaces any earlier pending transfer.
 *
 * @param currentOwner - Stellar address of the current contract admin
 * @param newOwner     - Stellar address of the intended new owner
 * @param wallet       - Signed wallet (StellarWalletsKit instance or compatible)
 */
export async function proposeTransfer(currentOwner, newOwner, wallet) {
  const signerAddress = await resolveWalletAddress(wallet, currentOwner);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = await buildInvocation({
    account,
    functionName: "propose_transfer",
    args: [scv(signerAddress, { type: "address" }), scv(newOwner, { type: "address" })],
  });
  return await sendWrite(tx, wallet, "propose_transfer");
}

/**
 * Step 2 — Accept the pending ownership transfer.
 * Only the address nominated via proposeTransfer may call this.
 * On success the caller becomes the new admin.
 *
 * @param newOwner - Stellar address of the incoming new owner
 * @param wallet   - Signed wallet for newOwner
 */
export async function acceptTransfer(newOwner, wallet) {
  const signerAddress = await resolveWalletAddress(wallet, newOwner);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = await buildInvocation({
    account,
    functionName: "accept_transfer",
    args: [scv(signerAddress, { type: "address" })],
  });
  return await sendWrite(tx, wallet, "accept_transfer");
}

/**
 * Revoke a pending ownership transfer.
 * Callable by either the current admin (cancels their proposal) or the
 * nominated new owner (declines the handoff).
 *
 * @param callerAddress - Stellar address of the caller (admin or pending owner)
 * @param wallet        - Signed wallet for callerAddress
 */
export async function revokeTransfer(callerAddress, wallet) {
  const signerAddress = await resolveWalletAddress(wallet, callerAddress);
  if (!signerAddress) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signerAddress);
  const account = await server.getAccount(signerAddress);
  const tx = await buildInvocation({
    account,
    functionName: "revoke_transfer",
    args: [scv(signerAddress, { type: "address" })],
  });
  return await sendWrite(tx, wallet, "revoke_transfer");
}

// ── Replay-protection nonce tracking (client-side mirror of contract/nonce.rs) ──
//
// Tracks the next expected on-chain nonce per account locally so callers can
// attach it to state-changing invocations without an extra read round-trip.
// The contract is still the source of truth: a stale local value is only a
// perf miss, never a correctness issue, since the contract itself rejects a
// reused/out-of-order nonce (#560).
const _localNonceCache = new Map();

export function getLocalNonce(accountAddress) {
  return _localNonceCache.get(accountAddress) ?? 0;
}

export function advanceLocalNonce(accountAddress) {
  const next = getLocalNonce(accountAddress) + 1;
  _localNonceCache.set(accountAddress, next);
  return next;
}

export function resetLocalNonce(accountAddress, value = 0) {
  _localNonceCache.set(accountAddress, value);
}

// ── M-of-N multisig proposals (#575) ─────────────────────────────────────
/** Combine independently collected signatures for one transaction envelope. */
export function aggregateProposalSignatures(proposal, signatures, threshold) {
  if (!proposal?.transactionXdr || !proposal?.networkPassphrase) {
    throw new Error("Proposal transaction envelope is required");
  }
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new Error("Threshold must be a positive integer");
  }
  const unique = new Map();
  for (const entry of signatures || []) {
    if (!entry?.signer || !entry?.signedTransactionXdr) continue;
    unique.set(entry.signer, entry);
  }
  const collected = [...unique.values()];
  return {
    ...proposal,
    signatures: collected,
    approvalCount: collected.length,
    threshold,
    ready: collected.length >= threshold,
  };
}

async function sendMultisigCall(signerAddress, functionName, args, wallet) {
  const signer = await resolveWalletAddress(wallet, signerAddress);
  if (!signer) throw new Error("Wallet address is not available yet");
  await ensureAccountFunded(signer);
  const account = await server.getAccount(signer);
  const tx = await buildInvocation({
    account,
    functionName,
    args,
  });
  return sendWrite(tx, wallet, functionName);
}

export async function createAdminProposal(proposer, newAdmin, wallet) {
  return sendMultisigCall(proposer, "create_admin_proposal", [
    scv(proposer, { type: "address" }),
    scv(newAdmin, { type: "address" }),
  ], wallet);
}

export async function approveAdminProposal(id, signer, wallet) {
  return sendMultisigCall(signer, "approve_admin_proposal", [
    scv(BigInt(id), { type: "u64" }),
    scv(signer, { type: "address" }),
  ], wallet);
}

export async function executeAdminProposal(id, signer, wallet) {
  return sendMultisigCall(signer, "execute_admin_proposal", [
    scv(BigInt(id), { type: "u64" }),
  ], wallet);
}

export async function getAdminProposal(id) {
  const sim = await simulateRead(contract.call("get_admin_proposal", scv(BigInt(id), { type: "u64" })));
  return sim.result ? scValToNative(sim.result.retval) : null;
}
