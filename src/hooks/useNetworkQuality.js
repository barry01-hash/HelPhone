import { useEffect, useSyncExternalStore } from "react";
import {
  getRpcHealthSnapshot,
  probeRpcNow,
  startRpcMonitoring,
  stopRpcMonitoring,
  subscribeRpcHealth,
} from "../lib/rpcHealth";

/**
 * Live RPC health for UI status indicators (#539).
 *
 * Starts the estimator's periodic probing while at least one component is
 * mounted and returns the latest snapshot:
 *   { activeLabel, activeLatencyMs, quality: 'good'|'degraded'|'offline'|'unknown',
 *     endpoints: [{ label, latencyMs, healthy, active, primary, ... }] }
 * plus `refresh()` to probe immediately.
 */
let consumers = 0;

export function useNetworkQuality() {
  const snapshot = useSyncExternalStore(
    subscribeRpcHealth,
    getRpcHealthSnapshot,
    getRpcHealthSnapshot,
  );

  useEffect(() => {
    consumers += 1;
    startRpcMonitoring();
    return () => {
      consumers -= 1;
      if (consumers === 0) stopRpcMonitoring();
    };
  }, []);

  return { ...snapshot, refresh: probeRpcNow };
}
