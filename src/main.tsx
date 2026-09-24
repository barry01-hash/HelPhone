import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { WalletProvider } from "./contexts/WalletContext";
import { i18nReady } from "./i18n";
import ErrorBoundary from "./components/ErrorBoundary";
import OfflineIndicator from "./components/OfflineIndicator";
import { initThemeEngine } from "./styles/themeEngine";
import { bootstrapMultiTabSync } from "./lib/swChannel";
import { initHelpStoreChannelSync } from "./stores/helpStore";
import { scheduleKeyDerivationBenchmark } from "./lib/pbkdf2Key";
import App from "./App";
import "./App.css";
import "./styles/theme.css";

// Heavy routes (Mapbox GL, ZK/WASM prover, Stellar RPC) are code-split so they
// are only fetched when the user actually navigates to them, keeping the
// initial bundle and Time-To-Interactive low.
const Help = lazy(() => import("./pages/Help"));
const Ranking = lazy(() => import("./pages/Ranking"));
const Admin = lazy(() => import("./pages/Admin"));
// #608 spike: WebGPU spatial-clustering prototype + benchmark harness (ADR-008).
const ClusterLab = lazy(() => import("./components/WebGPUMap"));
// Binary telemetry protocol spike: decode/GC benchmark harness (ADR-014).
const TelemetryLab = lazy(() => import("./components/TelemetryLab"));

function RouteFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        color: "#234B4E",
        fontFamily: "system-ui, sans-serif",
        fontSize: "0.95rem",
      }}
    >
      Loading…
    </div>
  );
}

initThemeEngine();
// Measure PBKDF2 latency off the critical path so a slow device is surfaced early.
scheduleKeyDerivationBenchmark();

function render() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        {/*
          WalletProvider wraps the entire app so that any page can access
          wallet state via useWallet() without prop-drilling.
          StellarWalletsKit.init() is called inside WalletProvider's useEffect,
          replacing the previous global side-effect at module load time.
        */}
        <WalletProvider>
          <BrowserRouter>
            <OfflineIndicator />
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<App />} />
                <Route path="/help" element={<Help />} />
                <Route path="/ranking" element={<Ranking />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="/lab/cluster-bench" element={<ClusterLab />} />
                <Route path="/lab/telemetry-bench" element={<TelemetryLab />} />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </WalletProvider>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

// Issue #516: multi-tab coordination. One tab (the Web-Locks leader) runs the
// Soroban/SSE poller and fans contract lifecycle events out to every other tab
// via BroadcastChannel + the service worker; CRDT stores listen for remote ops.
initHelpStoreChannelSync();
void bootstrapMultiTabSync();

// Wait for translation bundles to load before first render so the page
// never flashes untranslated keys.
i18nReady.then(render).catch(() => {
  // Translation load failed (e.g. offline) — render anyway with fallback keys.
  render();
});
