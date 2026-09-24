// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement } from "react";
import { render, screen, act, renderHook } from "@testing-library/react";
import {
  probeEndpoint,
  endpointLabel,
  parseEndpointList,
  createNetworkEstimator,
  EWMA_ALPHA,
  DEGRADED_LATENCY_MS,
} from "../src/lib/networkEstimator.ts";
import {
  initRpcHealth,
  getRpcHealthSnapshot,
  subscribeRpcHealth,
  startRpcMonitoring,
  stopRpcMonitoring,
  probeRpcNow,
  reportRpcFailure,
  __resetRpcHealth,
} from "../src/lib/rpcHealth.ts";
import { useNetworkQuality } from "../src/hooks/useNetworkQuality.js";
import { NetworkStatusIndicator } from "../src/components/NetworkStatusIndicator.jsx";

const A = "https://primary.example/rpc?key=SECRET";
const B = "https://backup-b.example";
const C = "https://backup-c.example";

const healthy = {
  ok: true,
  status: 200,
  json: async () => ({ result: { status: "healthy" } }),
};

/**
 * Fetch double keyed by hostname, driven by fake timers so parallel probes each
 * see only their own latency. Each entry is a latency in ms, "down" (network
 * error), or a raw response object. Requires vi.useFakeTimers().
 */
function makeNet(plan) {
  const now = () => Date.now();
  const fetchImpl = vi.fn(async (url) => {
    const host = new URL(url).hostname;
    const p = plan[host];
    if (p === "down") throw new Error("connect ECONNREFUSED");
    await new Promise((r) => setTimeout(r, typeof p === "number" ? p : 10));
    return typeof p === "number" ? healthy : p;
  });
  return { fetchImpl, now, plan };
}

/**
 * Instant (timer-free) net for the React tests, which run on real timers. Fine
 * for these cases because at most one endpoint is ever healthy, so the shared
 * clock cannot be contaminated by a parallel probe.
 */
function makeInstantNet(plan) {
  let t = 0;
  const fetchImpl = vi.fn(async (url) => {
    const p = plan[new URL(url).hostname];
    if (p === "down") throw new Error("connect ECONNREFUSED");
    t += p;
    return healthy;
  });
  return { fetchImpl, now: () => t, plan };
}

/** Let all pending fake-timer work run, then resolve with the promise's value. */
async function settle(promise) {
  await vi.advanceTimersByTimeAsync(10_000);
  return promise;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("probeEndpoint", () => {
  it("returns the measured latency for a healthy node and posts a getHealth JSON-RPC call", async () => {
    const { fetchImpl, now } = makeNet({ "primary.example": 120 });
    const r = await settle(probeEndpoint(A, { fetchImpl, now }));
    expect(r).toEqual({ ok: true, latencyMs: 120 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(A);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      jsonrpc: "2.0",
      method: "getHealth",
    });
  });

  it.each([
    [
      "HTTP 503",
      { ok: false, status: 503, json: async () => ({}) },
      "HTTP 503",
    ],
    [
      "an RPC error body",
      { ok: true, status: 200, json: async () => ({ error: { code: -1 } }) },
      "node not healthy",
    ],
    [
      "an unhealthy status",
      {
        ok: true,
        status: 200,
        json: async () => ({ result: { status: "syncing" } }),
      },
      "node not healthy",
    ],
  ])("marks %s as failed", async (_name, response, error) => {
    const r = await probeEndpoint(B, {
      fetchImpl: async () => response,
      now: () => 0,
    });
    expect(r).toMatchObject({ ok: false, error });
  });

  it("reports network errors as failures without throwing", async () => {
    const { fetchImpl, now } = makeNet({ "backup-b.example": "down" });
    expect(await settle(probeEndpoint(B, { fetchImpl, now }))).toMatchObject({
      ok: false,
      error: "connect ECONNREFUSED",
    });
  });

  it("aborts and reports a timeout when the node never answers", async () => {
    const fetchImpl = (_url, init) =>
      new Promise((_res, rej) =>
        init.signal.addEventListener("abort", () => rej(new Error("aborted"))),
      );
    const p = probeEndpoint(B, { fetchImpl, timeoutMs: 100, now: () => 0 });
    await vi.advanceTimersByTimeAsync(150);
    expect(await p).toMatchObject({ ok: false, error: "timeout" });
  });
});

describe("helpers", () => {
  it("labels an endpoint by hostname only, never leaking path or API key", () => {
    expect(endpointLabel(A)).toBe("primary.example");
    expect(endpointLabel("not a url")).toBe("invalid-url");
  });

  it("parses comma-separated lists, trimming, dropping blanks and duplicates", () => {
    expect(parseEndpointList(` ${A} , ${B}`, undefined, `${B},,${C}`)).toEqual([
      A,
      B,
      C,
    ]);
    expect(parseEndpointList()).toEqual([]);
  });
});

describe("createNetworkEstimator", () => {
  it("requires at least one endpoint", () => {
    expect(() => createNetworkEstimator({ endpoints: [] })).toThrow(
      /at least one endpoint/,
    );
  });

  it("starts on the primary with an optimistic, latency-less snapshot", () => {
    const est = createNetworkEstimator({ endpoints: [A, B] });
    const snap = est.getSnapshot();
    expect(est.getActiveUrl()).toBe(A);
    expect(snap).toMatchObject({
      activeLabel: "primary.example",
      activeLatencyMs: null,
      quality: "good",
    });
    expect(snap.endpoints.map((e) => [e.label, e.active, e.primary])).toEqual([
      ["primary.example", true, true],
      ["backup-b.example", false, false],
    ]);
  });

  it("dedupes endpoints and never exposes a full URL in the snapshot", async () => {
    const net = makeNet({ "primary.example": 50 });
    const est = createNetworkEstimator({ endpoints: [A, A], ...net });
    const snap = await settle(est.probeAll());
    expect(snap.endpoints).toHaveLength(1);
    expect(JSON.stringify(snap)).not.toContain("SECRET");
  });

  it("smooths latency with an EWMA across probes", async () => {
    const net = makeNet({ "primary.example": 100 });
    const est = createNetworkEstimator({ endpoints: [A], ...net });
    await settle(est.probeAll());
    net.plan["primary.example"] = 200;
    const snap = await settle(est.probeAll());
    expect(snap.endpoints[0].lastLatencyMs).toBe(200);
    expect(snap.endpoints[0].latencyMs).toBe(
      Math.round(EWMA_ALPHA * 200 + (1 - EWMA_ALPHA) * 100),
    );
  });

  it("stays on a healthy primary even when a backup is faster", async () => {
    const net = makeNet({ "primary.example": 400, "backup-b.example": 20 });
    const onChange = vi.fn();
    const est = createNetworkEstimator({ endpoints: [A, B], onChange, ...net });
    await settle(est.probeAll());
    expect(est.getActiveUrl()).toBe(A);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("tolerates transient failures below the threshold", async () => {
    const net = makeNet({ "primary.example": "down", "backup-b.example": 30 });
    const est = createNetworkEstimator({
      endpoints: [A, B],
      failureThreshold: 2,
      ...net,
    });
    const snap = await settle(est.probeAll());
    expect(est.getActiveUrl()).toBe(A);
    expect(snap.endpoints[0]).toMatchObject({
      healthy: true,
      consecutiveFailures: 1,
    });
  });

  it("fails over to the lowest-latency healthy backup once the primary is down, then fails back", async () => {
    const net = makeNet({
      "primary.example": "down",
      "backup-b.example": 300,
      "backup-c.example": 40,
    });
    const onChange = vi.fn();
    const est = createNetworkEstimator({
      endpoints: [A, B, C],
      failureThreshold: 2,
      onChange,
      ...net,
    });

    await settle(est.probeAll());
    const snap = await settle(est.probeAll());
    expect(est.getActiveUrl()).toBe(C);
    expect(onChange).toHaveBeenCalledWith(C, A);
    expect(snap).toMatchObject({
      activeLabel: "backup-c.example",
      quality: "good",
    });
    expect(snap.endpoints.find((e) => e.active).primary).toBe(false);

    net.plan["primary.example"] = 80; // primary recovers
    await settle(est.probeAll());
    expect(est.getActiveUrl()).toBe(A);
    expect(onChange).toHaveBeenLastCalledWith(A, C);
  });

  it("moves off a backup that itself fails, while the primary stays down", async () => {
    const net = makeNet({
      "primary.example": "down",
      "backup-b.example": 50,
      "backup-c.example": 90,
    });
    const est = createNetworkEstimator({
      endpoints: [A, B, C],
      failureThreshold: 1,
      ...net,
    });
    await settle(est.probeAll());
    expect(est.getActiveUrl()).toBe(B);

    net.plan["backup-b.example"] = "down";
    await settle(est.probeAll());
    expect(est.getActiveUrl()).toBe(C);
  });

  it("reports offline when every endpoint is down, and keeps the current active URL", async () => {
    const net = makeNet({
      "primary.example": "down",
      "backup-b.example": "down",
    });
    const onChange = vi.fn();
    const est = createNetworkEstimator({
      endpoints: [A, B],
      failureThreshold: 1,
      onChange,
      ...net,
    });
    const snap = await settle(est.probeAll());
    expect(snap.quality).toBe("offline");
    expect(est.getActiveUrl()).toBe(A);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports degraded when the active node is healthy but slow", async () => {
    const net = makeNet({ "primary.example": DEGRADED_LATENCY_MS + 100 });
    const est = createNetworkEstimator({ endpoints: [A], ...net });
    expect((await settle(est.probeAll())).quality).toBe("degraded");
  });

  it("reportFailure counts real request failures and triggers failover without a probe", async () => {
    const onChange = vi.fn();
    const est = createNetworkEstimator({
      endpoints: [A, B],
      failureThreshold: 2,
      onChange,
    });

    est.reportFailure("https://unknown.example"); // not in the pool: ignored
    est.reportFailure(A);
    expect(est.getActiveUrl()).toBe(A); // below threshold
    est.reportFailure(A);
    expect(est.getActiveUrl()).toBe(B);
    expect(onChange).toHaveBeenCalledWith(B, A);
    expect(est.getSnapshot().endpoints[0]).toMatchObject({
      healthy: false,
      consecutiveFailures: 2,
    });
  });

  it("coalesces overlapping probes into one round of requests", async () => {
    const net = makeNet({ "primary.example": 10 });
    const est = createNetworkEstimator({ endpoints: [A], ...net });
    await settle(Promise.all([est.probeAll(), est.probeAll(), est.probeAll()]));
    expect(net.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers with a fresh snapshot object, and stops after unsubscribe", async () => {
    const net = makeNet({ "primary.example": 10 });
    const est = createNetworkEstimator({ endpoints: [A], ...net });
    const listener = vi.fn();
    const off = est.subscribe(listener);
    const before = est.getSnapshot();
    expect(est.getSnapshot()).toBe(before); // stable between changes

    await settle(est.probeAll());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(est.getSnapshot()).not.toBe(before);

    off();
    await settle(est.probeAll());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe("scheduling", () => {
    it("probes immediately on start, then on every interval, until stopped (start is idempotent)", async () => {
      const net = makeNet({ "primary.example": 10 });
      const est = createNetworkEstimator({
        endpoints: [A],
        probeIntervalMs: 1000,
        ...net,
      });
      est.start();
      est.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(net.fetchImpl).toHaveBeenCalledTimes(1); // immediate first probe
      await vi.advanceTimersByTimeAsync(2000);
      expect(net.fetchImpl).toHaveBeenCalledTimes(3);
      est.stop();
      est.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(net.fetchImpl).toHaveBeenCalledTimes(3);
    });
  });
});

describe("rpcHealth singleton", () => {
  afterEach(() => __resetRpcHealth());

  it("reports an unknown, empty snapshot until an estimator is registered", async () => {
    expect(getRpcHealthSnapshot()).toMatchObject({
      quality: "unknown",
      endpoints: [],
    });
    expect(await settle(probeRpcNow())).toMatchObject({ quality: "unknown" });
    expect(() => reportRpcFailure()).not.toThrow();
    expect(() => startRpcMonitoring()).not.toThrow();
  });

  it("bridges the estimator to listeners registered before or after init", async () => {
    const early = vi.fn();
    subscribeRpcHealth(early);
    const net = makeNet({ "primary.example": 25 });
    initRpcHealth({ endpoints: [A], ...net });
    expect(early).toHaveBeenCalled(); // init itself notifies
    early.mockClear();

    const snap = await settle(probeRpcNow());
    expect(snap.endpoints[0].latencyMs).toBe(25);
    expect(early).toHaveBeenCalledTimes(1);
    expect(getRpcHealthSnapshot()).toBe(snap);
  });

  it("reportRpcFailure counts against the active endpoint", async () => {
    const net = makeNet({ "primary.example": 10, "backup-b.example": 10 });
    initRpcHealth({ endpoints: [A, B], failureThreshold: 1, ...net });
    await settle(probeRpcNow());
    reportRpcFailure();
    expect(getRpcHealthSnapshot().endpoints.find((e) => e.active).label).toBe(
      "backup-b.example",
    );
  });

  it("does not start probing under Vite's test mode", () => {
    const net = makeNet({ "primary.example": 10 });
    initRpcHealth({ endpoints: [A], ...net });
    startRpcMonitoring();
    expect(net.fetchImpl).not.toHaveBeenCalled();
    stopRpcMonitoring();
  });

  it("starts probing when monitoring is enabled outside test mode, and replaces a previous estimator", async () => {
    vi.stubEnv("MODE", "production");
    const net1 = makeNet({ "primary.example": 10 });
    initRpcHealth({ endpoints: [A], probeIntervalMs: 60_000, ...net1 });
    startRpcMonitoring();
    await Promise.resolve();
    expect(net1.fetchImpl).toHaveBeenCalledTimes(1);

    const net2 = makeNet({ "backup-b.example": 10 });
    initRpcHealth({ endpoints: [B], probeIntervalMs: 60_000, ...net2 }); // inherits monitoring=true
    await Promise.resolve();
    expect(net2.fetchImpl).toHaveBeenCalledTimes(1);
    stopRpcMonitoring();
    vi.unstubAllEnvs();
  });

  it("honours VITE_DISABLE_RPC_MONITOR", () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("VITE_DISABLE_RPC_MONITOR", "true");
    const net = makeNet({ "primary.example": 10 });
    initRpcHealth({ endpoints: [A], ...net });
    startRpcMonitoring();
    expect(net.fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });
});

describe("useNetworkQuality / NetworkStatusIndicator", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => __resetRpcHealth());

  it("exposes the snapshot plus refresh, and re-renders on change", async () => {
    const net = makeInstantNet({ "primary.example": 33 });
    initRpcHealth({ endpoints: [A], ...net });
    const { result } = renderHook(() => useNetworkQuality());
    expect(result.current.quality).toBe("good");
    expect(result.current.activeLatencyMs).toBeNull();

    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.activeLatencyMs).toBe(33);
  });

  it("renders nothing while the health state is unknown", () => {
    const { container } = render(createElement(NetworkStatusIndicator));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows quality, latency and node label, and flags a backup node", async () => {
    const net = makeInstantNet({
      "primary.example": "down",
      "backup-b.example": 45,
    });
    initRpcHealth({ endpoints: [A, B], failureThreshold: 1, ...net });
    render(createElement(NetworkStatusIndicator));
    expect(screen.getByTestId("network-status")).toHaveTextContent(
      "Network good",
    );

    await act(async () => {
      await probeRpcNow();
    });
    const status = screen.getByTestId("network-status");
    expect(status).toHaveTextContent("Network good · 45 ms · backup node");
    expect(status).toHaveAttribute("title", "RPC node: backup-b.example");
    expect(status).toHaveAttribute("role", "status");
    expect(status.textContent).not.toContain("SECRET");
  });

  it("shows offline and slow states", async () => {
    const net = makeInstantNet({ "primary.example": "down" });
    initRpcHealth({ endpoints: [A], failureThreshold: 1, ...net });
    render(createElement(NetworkStatusIndicator));
    await act(async () => {
      await probeRpcNow();
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent(
      "Network offline",
    );

    net.plan["primary.example"] = DEGRADED_LATENCY_MS + 200;
    await act(async () => {
      await probeRpcNow();
    });
    expect(screen.getByTestId("network-status")).toHaveTextContent(
      "Network slow",
    );
  });
});
