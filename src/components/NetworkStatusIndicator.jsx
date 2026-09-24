import { useNetworkQuality } from "../hooks/useNetworkQuality.js";

const NETWORK_QUALITY_STYLES = {
  good: { color: "#5fbf8f", label: "Network good" },
  degraded: { color: "#e0b14a", label: "Network slow" },
  offline: { color: "#e5645b", label: "Network offline" },
};

/** Live RPC health pill (#539): quality, active node and its smoothed latency.
 *  Renders nothing until an RPC estimator is registered. */
export function NetworkStatusIndicator() {
  const { quality, activeLabel, activeLatencyMs, endpoints } =
    useNetworkQuality();
  const style = NETWORK_QUALITY_STYLES[quality];
  if (!style) return null;
  const usingBackup = endpoints.some((e) => e.active && !e.primary);
  const latency = activeLatencyMs === null ? "" : ` · ${activeLatencyMs} ms`;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="network-status"
      title={`RPC node: ${activeLabel}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "11px",
        color: "rgba(242,236,220,0.6)",
        marginBottom: "10px",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: style.color,
        }}
      />
      <span>
        {style.label}
        {latency}
        {usingBackup ? " · backup node" : ""}
      </span>
    </div>
  );
}
