import styles from "./Help.module.css";
import { cx } from "../styles/cssModules";
import { useState, useEffect, useRef, Fragment, useCallback } from "react";
import { Link } from "react-router-dom";
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { KitEventType } from "@creit-tech/stellar-wallets-kit/types";
import Map, {
  Marker,
  Popup,
  Source,
  Layer,
  NavigationControl,
  useMap,
} from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import {
  getRequest,
  getActiveRequests,
  getResponder,
  getResponderCount,
  createRequest,
  acceptRequest,
  markArrived,
  resolveRequest,
  cancelRequest,
  getRanking,
  ensureAccountFunded,
  updateLocation,
  recordExpertVerification,
} from "../lib/contract";
import { NetworkStatusIndicator } from "../components/NetworkStatusIndicator.jsx";
import {
  buildLocationProofZone,
  generateLocationProof,
  shortProofId,
} from "../lib/zk";
import {
  processImage,
  MAX_DIMENSION,
  DEFAULT_QUALITY,
} from "../lib/imageProcessor.js";
import {
  restoreDraft,
  startAutoSave,
  clearDraft as clearCrashDraft,
} from "../lib/crashRecovery.ts";

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;

const MAP_STYLES = [
  {
    id: "satellite",
    name: "Warm",
    url: "mapbox://styles/kl0ren/cmqn3p0zx000q01s69sp8ai7b",
    desc: "Custom warm style with earth greens and coral accents. Great for everyday use.",
  },
  {
    id: "claro",
    name: "Standard",
    url: "mapbox://styles/mapbox/standard",
    desc: "Clean, neutral base map. Good contrast for reading streets and names.",
  },
  {
    id: "dark",
    name: "Dark 2D",
    url: "mapbox://styles/mapbox/dark-v11",
    desc: "Dark background — reduces glare, ideal for low-light or nighttime use.",
  },
];

const CHARS = {
  male: ["runner", "pacheco", "growth", "jumping-air"],
  female: ["chilly", "meela-pantalones", "feliz", "pondering"],
  undisclosed: ["cube-leg", "roboto", "mechanical-love"],
  default: ["looking-ahead", "waiting", "bueno"],
};

function pickChar(gender, seed = "") {
  const pool = CHARS[gender] || CHARS.default;
  const s = String(seed);
  const idx =
    s.split("").reduce((a, c) => a + c.charCodeAt(0), 0) % pool.length;
  return pool[idx];
}

function CharMarker({
  charName,
  accentColor = "#FF7A6B",
  lat,
  lng,
  onClick,
  children,
}) {
  return (
    <Marker latitude={lat} longitude={lng} onClick={onClick}>
      <div
        style={{
          position: "relative",
          width: 52,
          height: 52,
          cursor: "pointer",
        }}
      >
        <img
          src={`/assets/chars/${charName}.png`}
          style={{
            width: 52,
            height: 52,
            objectFit: "contain",
            filter: "drop-shadow(0 3px 8px rgba(0,0,0,0.28))",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: 0,
            right: 0,
            width: 13,
            height: 13,
            borderRadius: "50%",
            background: accentColor,
            border: "2.5px solid #fff",
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
          }}
        />
      </div>
      {children}
    </Marker>
  );
}

function MapController({ center, zoom = 14 }) {
  const { current: map } = useMap();
  useEffect(() => {
    if (center && map)
      map.flyTo({ center: [center[1], center[0]], zoom, duration: 1200 });
  }, [center, zoom, map]);
  return null;
}

function distance(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a[0] * Math.PI) / 180) *
      Math.cos((b[0] * Math.PI) / 180) *
      sinLng *
      sinLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function RouteLine({ id: routeId, from, to, color = "#7357FF" }) {
  const id = `route-${routeId || `${from[0]}-${from[1]}-${to[0]}-${to[1]}`}`;
  return (
    <Source
      id={id}
      type="geojson"
      data={{
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [from[1], from[0]],
            [to[1], to[0]],
          ],
        },
      }}
    >
      <Layer
        id={`${id}-line`}
        type="line"
        paint={{
          "line-color": color,
          "line-width": 2,
          "line-opacity": 0.65,
          "line-dasharray": [10, 6],
        }}
      />
    </Source>
  );
}

function loadProfile() {
  try {
    return JSON.parse(localStorage.getItem("hp_profile") || "{}");
  } catch {
    return {};
  }
}

const DEFAULT_CENTER = [20, 0];

const MY_REQUESTS_KEY = "hp_my_requests";

function loadMyRequestIds() {
  try {
    return JSON.parse(localStorage.getItem(MY_REQUESTS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveMyRequestId(id) {
  const ids = loadMyRequestIds();
  if (!ids.includes(id)) {
    ids.unshift(id);
    localStorage.setItem(MY_REQUESTS_KEY, JSON.stringify(ids.slice(0, 20)));
  }
}

function anonymizeLocation(location) {
  if (!location) return location;
  return [
    Math.round(location[0] * 100) / 100,
    Math.round(location[1] * 100) / 100,
  ];
}

function privateRequestLabel(id) {
  return `Private request #${id || "pending"}`;
}

function txExplorerUrl(hash) {
  if (!hash) return null;
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

function ExplorerLink({ label, hash }) {
  const url = txExplorerUrl(hash);
  if (!url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={`View ${label.toLowerCase()} on Stellar Expert (testnet)`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "10px",
        color: "#7fb8ba",
        textDecoration: "none",
        fontFamily: "'Courier New', monospace",
        cursor: "pointer",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.textDecoration = "underline";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = "none";
      }}
    >
      <span style={{ color: "rgba(242,236,220,0.4)" }}>{label}</span>
      <span>{shortProofId(hash)}</span>
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0 }}
        aria-hidden="true"
      >
        <path d="M7 17L17 7M17 7H8M17 7v9" />
      </svg>
    </a>
  );
}

function ArrivalThanksModal({ open, onClose, requestLabel, txHash }) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="arrival-thanks-title"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.68)",
        zIndex: 10000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: "390px",
          borderRadius: "18px",
          background: "#1c3535",
          border: "1px solid rgba(63,132,135,0.32)",
          boxShadow: "0 24px 70px rgba(0,0,0,0.58)",
          padding: "24px 22px 20px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: "52px",
            height: "52px",
            borderRadius: "50%",
            margin: "0 auto 14px",
            background: "rgba(63,132,135,0.16)",
            border: "1px solid rgba(63,132,135,0.42)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#3F8487",
          }}
        >
          <svg
            width="25"
            height="25"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h3
          id="arrival-thanks-title"
          style={{
            margin: "0 0 8px",
            fontFamily: "'Instrument Serif',serif",
            fontWeight: 400,
            fontSize: "26px",
            lineHeight: 1.08,
            color: "#F4ECDC",
          }}
        >
          Thank you for helping
        </h3>
        <p
          style={{
            margin: "0 0 14px",
            fontSize: "13px",
            color: "rgba(242,236,220,0.56)",
            lineHeight: 1.55,
          }}
        >
          Your arrival has been recorded on Stellar. Because you showed up,
          someone nearby knows they are not alone.
        </p>
        {requestLabel && (
          <div
            style={{
              margin: "0 auto 14px",
              display: "inline-flex",
              padding: "5px 9px",
              borderRadius: "7px",
              background: "rgba(255,255,255,0.06)",
              color: "rgba(242,236,220,0.58)",
              fontSize: "11px",
              fontWeight: 700,
            }}
          >
            {requestLabel}
          </div>
        )}
        {txHash && (
          <div
            style={{
              marginBottom: "14px",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <ExplorerLink label="Arrival receipt" hash={txHash} />
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            minHeight: "44px",
            padding: "11px 14px",
            borderRadius: "10px",
            border: "none",
            background: "#3F8487",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 800,
            cursor: "pointer",
          }}
        >
          Done
        </button>
      </div>
    </div>
  );
}

function proofCampaignId(seed) {
  const text = String(seed || Date.now());
  let acc = 0n;
  for (const ch of text)
    acc = (acc * 131n + BigInt(ch.charCodeAt(0))) % 999999937n;
  return String(acc + 1n);
}

function Step({ n, title, subtitle, done, active, children }) {
  return (
    <div
      style={{
        marginBottom: "6px",
        opacity: !active && !done ? 0.38 : 1,
        transition: "opacity 0.3s",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          marginBottom: children ? "12px" : 0,
        }}
      >
        <div
          style={{
            width: "26px",
            height: "26px",
            borderRadius: "50%",
            flexShrink: 0,
            background: done
              ? "#3F8487"
              : active
                ? "#FF7A6B"
                : "rgba(255,255,255,0.1)",
            border: `2px solid ${done ? "#3F8487" : active ? "#FF7A6B" : "rgba(255,255,255,0.2)"}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "12px",
            fontWeight: "700",
            color: done || active ? "#fff" : "rgba(242,236,220,0.4)",
          }}
        >
          {done ? "✓" : n}
        </div>
        <div>
          <div
            style={{
              fontSize: "13px",
              fontWeight: "600",
              color: done
                ? "#3F8487"
                : active
                  ? "rgba(242,236,220,0.95)"
                  : "rgba(242,236,220,0.45)",
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: "11px",
                color: "rgba(242,236,220,0.35)",
                marginTop: "1px",
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {children && <div style={{ marginLeft: "36px" }}>{children}</div>}
    </div>
  );
}

export const HELP_ONBOARDING_STEPS = [
  {
    label: "Request",
    title: "Help when you need it",
    body: "HelPhone connects you with people nearby when you're in an emergency. You can request help or offer help to others. Everything runs on Stellar — fast, public, and verifiable.",
  },
  {
    label: "Receipt",
    title: "Your action goes on-chain first",
    body: "When you request or offer help, Stellar confirms it in seconds. That creates a public transaction hash — your receipt.",
  },
  {
    label: "Wallet",
    title: "Connect your preferred wallet",
    body: "Your Stellar wallet only signs transactions — it's not a tracking tool. Connect to request help, offer help, or verify your identity on the network.",
    isLast: true,
  },
];

function HelpOnboardingModal({ open, onClose, onConnectWallet }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  if (!open) return null;

  const totalSteps = HELP_ONBOARDING_STEPS.length;
  const steps = HELP_ONBOARDING_STEPS;
  const current = steps[step];

  async function handleLastAction() {
    if (step === totalSteps - 1) {
      onClose();
      await onConnectWallet();
    } else {
      setStep((s) => s + 1);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "18px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "460px",
          borderRadius: "18px",
          background: "#1c2c24",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.62)",
          overflow: "hidden",
          transition: "opacity 0.25s",
        }}
      >
        <div
          style={{
            padding: "18px 20px 0",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <div
            style={{
              fontSize: "10px",
              letterSpacing: "1.4px",
              color: "#7fb8ba",
              fontWeight: 900,
            }}
          >
            HELPHONE GUIDE
          </div>
          <button
            type="button"
            aria-label="Close guide"
            onClick={onClose}
            style={{
              width: "34px",
              height: "34px",
              borderRadius: "8px",
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.05)",
              color: "rgba(242,236,220,0.65)",
              cursor: "pointer",
              fontSize: "18px",
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>

        <div
          style={{
            padding: "14px 24px 0",
            display: "flex",
            gap: "8px",
            alignItems: "center",
          }}
        >
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: "4px",
                borderRadius: "4px",
                background:
                  i === step
                    ? "#FF7A6B"
                    : i < step
                      ? "#3F8487"
                      : "rgba(255,255,255,0.1)",
                transition: "background 0.3s",
              }}
            />
          ))}
        </div>

        <div style={{ padding: "26px 24px 8px", textAlign: "center" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: "74px",
              height: "34px",
              padding: "0 12px",
              borderRadius: "999px",
              background: "rgba(63,132,135,0.14)",
              border: "1px solid rgba(63,132,135,0.28)",
              color: "#7fb8ba",
              fontSize: "11px",
              fontWeight: 900,
              letterSpacing: "1px",
              marginBottom: "16px",
            }}
          >
            {step + 1}/{totalSteps} · {current.label}
          </div>
          <h2
            style={{
              margin: "0 0 10px",
              color: "#F4ECDC",
              fontSize: "22px",
              lineHeight: 1.15,
              fontWeight: 700,
            }}
          >
            {current.title}
          </h2>
          <p
            style={{
              margin: 0,
              color: "rgba(242,236,220,0.55)",
              fontSize: "14px",
              lineHeight: 1.6,
              padding: "0 6px",
            }}
          >
            {current.body}
          </p>
        </div>

        <div style={{ padding: "24px", display: "flex", gap: "10px" }}>
          {step > 0 && (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              style={{
                padding: "12px 18px",
                borderRadius: "10px",
                border: "1px solid rgba(255,255,255,0.1)",
                background: "rgba(255,255,255,0.05)",
                color: "rgba(242,236,220,0.65)",
                fontSize: "14px",
                fontWeight: 600,
                cursor: "pointer",
                minWidth: "80px",
              }}
            >
              Back
            </button>
          )}
          <button
            type="button"
            onClick={handleLastAction}
            style={{
              flex: 1,
              minHeight: "48px",
              borderRadius: "10px",
              border: "none",
              background: step === totalSteps - 1 ? "#7357FF" : "#FF7A6B",
              color: "#fff",
              fontSize: "15px",
              fontWeight: 700,
              cursor: "pointer",
              transition: "background 0.2s",
            }}
          >
            {step === totalSteps - 1 ? "Connect preferred wallet" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TrackingScreen({
  responderLat,
  responderLng,
  responderAddress,
  responderChar,
  requesterLat,
  requesterLng,
  requesterChar,
  etaSeconds,
  isArrived,
  isResponderView,
  isMarkingArrived,
  onMarkArrived,
  onResolve,
}) {
  const dist =
    requesterLat != null && responderLat != null
      ? Math.round(
          distance([requesterLat, requesterLng], [responderLat, responderLng]) *
            10,
        ) / 10
      : null;
  const etaMin = etaSeconds ? Math.round(etaSeconds / 60) : null;

  return (
    <>
      {responderLat != null && (
        <CharMarker
          charName={responderChar || pickChar("default", responderAddress)}
          accentColor="#7357FF"
          lat={responderLat}
          lng={responderLng}
        >
          {!isArrived && (
            <div
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: "52px",
                height: "52px",
                transform: "translate(-50%, -50%) scale(1.5)",
                borderRadius: "50%",
                border: "2px solid rgba(115,87,255,0.3)",
                animation: "mdpulse 2s ease-out infinite",
                pointerEvents: "none",
              }}
            />
          )}
        </CharMarker>
      )}
      {responderLat != null && requesterLat != null && (
        <RouteLine
          id="tracking-route"
          from={[responderLat, responderLng]}
          to={[requesterLat, requesterLng]}
          color="#7357FF"
        />
      )}

      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          background: "linear-gradient(transparent, rgba(0,0,0,0.7) 30%)",
          padding: "40px 20px 20px",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            background: "#1c2c24",
            borderRadius: "16px",
            padding: "16px 18px",
            border: "1px solid rgba(255,255,255,0.08)",
            maxWidth: "460px",
            margin: "0 auto",
            pointerEvents: "auto",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                width: "8px",
                height: "8px",
                borderRadius: "50%",
                background: isArrived ? "#3F8487" : "#7357FF",
                animation: isArrived
                  ? "none"
                  : "mdblink 1.4s steps(1) infinite",
              }}
            />
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                letterSpacing: "1.5px",
                color: isArrived ? "#3F8487" : "#B3A6FF",
              }}
            >
              {isArrived ? "ARRIVED" : "EN ROUTE"}
            </span>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "8px",
              marginBottom: "12px",
            }}
          >
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.32)",
                  marginBottom: "4px",
                }}
              >
                RESPONDER
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: "#F4ECDC",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {responderAddress
                  ? `${responderAddress.slice(0, 8)}...`
                  : "Unknown"}
              </div>
            </div>
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.32)",
                  marginBottom: "4px",
                }}
              >
                DISTANCE
              </div>
              <div style={{ fontSize: "11px", color: "#F4ECDC" }}>
                {dist != null ? `${dist} km` : "—"}
              </div>
            </div>
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.32)",
                  marginBottom: "4px",
                }}
              >
                ETA
              </div>
              <div style={{ fontSize: "11px", color: "#F4ECDC" }}>
                {isArrived ? "Arrived" : etaMin != null ? `${etaMin} min` : "—"}
              </div>
            </div>
            <div
              style={{
                padding: "9px 10px",
                borderRadius: "8px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <div
                style={{
                  fontSize: "9px",
                  letterSpacing: "1px",
                  color: "rgba(242,236,220,0.32)",
                  marginBottom: "4px",
                }}
              >
                STATUS
              </div>
              <div
                style={{
                  fontSize: "11px",
                  color: isArrived ? "#3F8487" : "#B3A6FF",
                }}
              >
                {isArrived ? "Arrived" : "En Route"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            {isResponderView && !isArrived && (
              <button
                onClick={onMarkArrived}
                disabled={isMarkingArrived}
                style={{
                  flex: 1,
                  padding: "11px 14px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#3F8487",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: isMarkingArrived ? "default" : "pointer",
                  opacity: isMarkingArrived ? 0.7 : 1,
                }}
              >
                {isMarkingArrived ? "Recording arrival..." : "Mark Arrived"}
              </button>
            )}
            {!isResponderView && isArrived && (
              <button
                onClick={onResolve}
                style={{
                  flex: 1,
                  padding: "11px 14px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#7357FF",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Resolve Request
              </button>
            )}
            {isResponderView && isArrived && (
              <div
                style={{
                  flex: 1,
                  padding: "11px 14px",
                  borderRadius: "10px",
                  background: "rgba(63,132,135,0.12)",
                  color: "#3F8487",
                  fontSize: "12px",
                  fontWeight: 700,
                  textAlign: "center",
                  border: "1px solid rgba(63,132,135,0.25)",
                }}
              >
                ARRIVED ✓
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const EMERGENCY_TYPES = [
  {
    id: "lost",
    icon: "🧭",
    label: "I'm lost",
    desc: "Don't know where I am or how to get back",
  },
  {
    id: "fallen",
    icon: "🩹",
    label: "Fell / injured",
    desc: "Need assistance after a fall or injury",
  },
  {
    id: "medical",
    icon: "🏥",
    label: "Medical emergency",
    desc: "Health issue that can't wait",
  },
  {
    id: "car",
    icon: "🔧",
    label: "Car trouble",
    desc: "Vehicle broke down on the road",
  },
  {
    id: "danger",
    icon: "🛡️",
    label: "I feel unsafe",
    desc: "Unsafe situation, need someone nearby",
  },
  {
    id: "other",
    icon: "⋯",
    label: "Something else",
    desc: "Another type of emergency",
  },
];

const ET_ICONS = {
  lost: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path
        d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36z"
        fill="currentColor"
        strokeWidth="0"
      />
    </svg>
  ),
  fallen: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="4.5" r="1.8" fill="currentColor" stroke="none" />
      <path d="M9 9c-1.5 1.5-2.5 3.5-2 5.5" />
      <path d="M12 7v5l3.5 4" />
      <path d="M10 12.5 7 18" />
    </svg>
  ),
  medical: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      <polyline points="8 12.5 10 10.5 12 14 14 9 16 12.5" strokeWidth="1.5" />
    </svg>
  ),
  car: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 17H3a2 2 0 0 1-2-2v-4a2 2 0 0 1 .5-1.5L5 6h14l3.5 3.5A2 2 0 0 1 23 11v4a2 2 0 0 1-2 2h-2" />
      <circle cx="7.5" cy="17" r="2.5" />
      <circle cx="16.5" cy="17" r="2.5" />
    </svg>
  ),
  danger: (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <circle cx="12" cy="16.5" r="0.8" fill="currentColor" stroke="none" />
    </svg>
  ),
  other: (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="5.5" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="18.5" cy="12" r="1.8" fill="currentColor" />
    </svg>
  ),
};

export default function Help() {
  const [mode, setMode] = useState("get");

  const [profile, setProfile] = useState(() => {
    const p = loadProfile();
    return { nickname: p.nickname || "", contact: p.contact || "" };
  });

  const [emergencyType, setEmergencyType] = useState(null);
  const [showEmergencyModal, setShowEmergencyModal] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(true);

  const [location, setLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchSuggestions, setSearchSuggestions] = useState([]);
  const [searchSuggestLoading, setSearchSuggestLoading] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const searchBoxRef = useRef(null);
  const searchAbortRef = useRef(null);

  const [requestId, setRequestId] = useState(null);
  const [requestStatus, setRequestStatus] = useState("idle");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [responders, setResponders] = useState([]);
  const [popupMarker, setPopupMarker] = useState(null);
  const [selectedChar, setSelectedChar] = useState(null);
  const [mapStyleIndex, setMapStyleIndex] = useState(0);
  const [styleOpen, setStyleOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [showMobileForm, setShowMobileForm] = useState(false);
  const [myRequests, setMyRequests] = useState([]);
  const [myRequestsLoading, setMyRequestsLoading] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(null);

  const [openRequests, setOpenRequests] = useState([]);
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [offerSubmitting, setOfferSubmitting] = useState(false);
  const [lastOfferReceipt, setLastOfferReceipt] = useState(null);
  const [trackingRequestId, setTrackingRequestId] = useState(null);
  const [trackingIndex, setTrackingIndex] = useState(null);
  const [responderArrived, setResponderArrived] = useState(false);
  const [arrivalSubmitting, setArrivalSubmitting] = useState(false);
  const [arrivalThanksOpen, setArrivalThanksOpen] = useState(false);
  const [requesterLocation, setRequesterLocation] = useState(null);
  const [zkStatus, setZkStatus] = useState("idle");
  const [zkLogs, setZkLogs] = useState([]);
  const [zkProof, setZkProof] = useState(null);
  const [zkError, setZkError] = useState("");

  const [walletAddress, setWalletAddress] = useState("");
  const activeWalletAddress = walletAddress;
  const isWalletConnected = !!activeWalletAddress;
  const styleSelectorRef = useRef(null);
  const profileRef = useRef(null);
  const sidebarRef = useRef(null);
  const handleOfferBusy = useRef(false);
  const handleOfferMounted = useRef(true);
  const handleOfferSeq = useRef(0);

  // ── Crash Recovery: IndexedDB draft restore & auto-save ───────────────────
  const [draftBanner, setDraftBanner] = useState(
    /** @type {'idle'|'found'|'dismissed'} */ ("idle"),
  );

  // On mount: check for a saved draft and rehydrate form state
  useEffect(() => {
    let cancelled = false;
    restoreDraft()
      .then((draft) => {
        if (cancelled || !draft) return;
        if (draft.emergencyType) setEmergencyType(draft.emergencyType);
        if (draft.nickname || draft.contact) {
          setProfile((prev) => ({
            nickname: draft.nickname || prev.nickname,
            contact: draft.contact || prev.contact,
          }));
        }
        if (draft.location) setLocation(draft.location);
        if (draft.searchQuery) setSearchQuery(draft.searchQuery);
        setDraftBanner("found");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []); // mount-only — intentionally empty dep array (restoreDraft runs once)

  // Auto-save form state to IndexedDB every 2s while filling the request form
  useEffect(() => {
    const stop = startAutoSave(() => ({
      emergencyType: emergencyType ?? null,
      nickname: profile.nickname,
      contact: profile.contact,
      location: location ?? null,
      searchQuery,
    }));
    return stop;
  }, [emergencyType, profile, location, searchQuery]);

  useEffect(() => {
    if (!location?.[0] || !location?.[1]) return;
  }, [location?.[0], location?.[1]]);

  useEffect(() => {
    let mounted = true;
    let offState = () => {};
    let offDisconnect = () => {};

    async function syncWallet() {
      try {
        const { address } = await StellarWalletsKit.getAddress();
        if (mounted) setWalletAddress(address || "");
      } catch {
        if (mounted) setWalletAddress("");
      }
    }

    syncWallet();
    offState = StellarWalletsKit.on(KitEventType.STATE_UPDATED, (event) => {
      if (!mounted) return;
      setWalletAddress(event?.payload?.address || "");
    });
    offDisconnect = StellarWalletsKit.on(KitEventType.DISCONNECT, () => {
      if (mounted) setWalletAddress("");
      setProfileOpen(false);
    });

    return () => {
      mounted = false;
      offState();
      offDisconnect();
    };
  }, []);

  useEffect(() => {
    return () => {
      handleOfferMounted.current = false;
    };
  }, []);


  useEffect(() => {
    if (!styleOpen) return;
    function onDocClick(e) {
      if (
        styleSelectorRef.current &&
        !styleSelectorRef.current.contains(e.target)
      )
        setStyleOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [styleOpen]);

  useEffect(() => {
    if (!profileOpen) return;
    function onDocClick(e) {
      if (profileRef.current && !profileRef.current.contains(e.target))
        setProfileOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [profileOpen]);

  useEffect(() => {
    localStorage.setItem("hp_profile", JSON.stringify(profile));
  }, [profile]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchSuggestions([]);
      return;
    }

    let mounted = true;
    const timeout = setTimeout(async () => {
      try {
        setSearchSuggestLoading(true);
        const res = await fetch(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(searchQuery.trim())}.json?access_token=${MAPBOX_TOKEN}&autocomplete=true&limit=5`,
        );
        const data = await res.json();
        if (!mounted) return;
        setSearchSuggestions(data.features || []);
        setActiveSuggestion(-1);
      } catch {
        if (mounted) setSearchSuggestions([]);
      } finally {
        if (mounted) setSearchSuggestLoading(false);
      }
    }, 260);

    return () => {
      mounted = false;
      clearTimeout(timeout);
    };
  }, [searchQuery]);

  useEffect(() => {
    if (searchSuggestions.length === 0) return;
    function onPointerDown(e) {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) {
        setSearchSuggestions([]);
        setActiveSuggestion(-1);
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [searchSuggestions.length]);

  useEffect(() => {
    requestLocation();
  }, []);

  useEffect(() => {
    if (mode !== "offer") return;
    let mounted = true;
    let loading = false;

    async function load() {
      if (loading) return;
      loading = true;
      try {
        const ids = await getActiveRequests();
        const requests = await Promise.all(
          ids.map((id) =>
            getRequest(id)
              .then((req) =>
                req && req.status === "Pending" ? { ...req, id } : null,
              )
              .catch(() => null),
          ),
        ).then((results) => results.filter(Boolean));
        if (mounted) {
          setOpenRequests(requests);
          setSelectedRequest((current) => {
            if (!current) return current;
            return (
              requests.find((req) => Number(req.id) === Number(current.id)) ||
              null
            );
          });
        }
      } catch (_) {}
      loading = false;
    }

    load();
    const interval = setInterval(load, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [mode]);

  function requestLocation() {
    if (!navigator.geolocation) {
      setLocationError("Browser does not support geolocation. Search by city.");
      return;
    }
    setLocating(true);
    setLocationError("");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation([pos.coords.latitude, pos.coords.longitude]);
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setLocationError(
          err.code === 1
            ? "Location blocked. Search by city, or click the map to drop a pin."
            : "Could not get location. Search below or click the map.",
        );
      },
      { timeout: 12000 },
    );
  }

  async function promptWalletConnection() {
    try {
      // Defer opening the modal to the next macrotask so the click handler
      // that triggered this returns immediately instead of holding the main
      // thread while the wallet-kit UI mounts (source of the inconsistent
      // cross-browser behavior, worst on Safari/Firefox).
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { address } = await StellarWalletsKit.authModal();
      if (address) {
        setWalletAddress(address);
        return address;
      }
    } catch (err) {
      if (err?.message) {
        console.warn("Wallet connection cancelled or failed:", err.message);
      }
    }
    return "";
  }

  async function handleSearch(e) {
    e.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    // Cancel any in-flight search before starting a new one, instead of
    // letting overlapping requests race and both allocate/parse response
    // bodies that only the latest result actually needs.
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchError("");
    setSearchSuggestions([]);
    setSearchLoading(true);
    try {
      const res = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${MAPBOX_TOKEN}&limit=1`,
        { signal: controller.signal },
      );
      const data = await res.json();
      if (!data.features?.length) {
        setSearchError("Place not found.");
        setSearchLoading(false);
        return;
      }
      const [lng, lat] = data.features[0].center;
      setLocation([lat, lng]);
      setLocationError("");
      setSearchSuggestions([]);
    } catch (err) {
      if (err?.name !== "AbortError")
        setSearchError("Search failed. Check your connection.");
      else return;
    }
    setSearchLoading(false);
  }

  function selectSearchSuggestion(feature) {
    if (!Array.isArray(feature?.center) || feature.center.length !== 2) return;
    const [lng, lat] = feature.center;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    setLocation([lat, lng]);
    setLocationError("");
    setSearchQuery(feature.place_name || feature.text || "");
    setSearchSuggestions([]);
    setActiveSuggestion(-1);
    setSearchError("");
  }

  function handleSearchKeyDown(e) {
    if (searchSuggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSuggestion((i) => (i + 1) % searchSuggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSuggestion((i) =>
        i <= 0 ? searchSuggestions.length - 1 : i - 1,
      );
    } else if (e.key === "Enter") {
      if (activeSuggestion >= 0 && searchSuggestions[activeSuggestion]) {
        e.preventDefault();
        selectSearchSuggestion(searchSuggestions[activeSuggestion]);
      }
    } else if (e.key === "Escape") {
      setSearchSuggestions([]);
      setActiveSuggestion(-1);
    }
  }

  function validLocation() {
    return (
      location && Number.isFinite(location[0]) && Number.isFinite(location[1])
    );
  }

  function pushZkLog(message) {
    setZkLogs((prev) => [...prev.slice(-5), message]);
  }

  function resetZkCheckpoint() {
    setZkStatus("idle");
    setZkLogs([]);
    setZkProof(null);
    setZkError("");
  }

  function removeOpenRequest(reqId) {
    setSelectedRequest((current) =>
      Number(current?.id) === Number(reqId) ? null : current,
    );
    setOpenRequests((prev) =>
      prev.filter((r) => Number(r.id) !== Number(reqId)),
    );
  }

  function syncOpenRequest(reqId, fresh) {
    const request = { ...fresh, id: reqId };
    setOpenRequests((prev) =>
      prev.map((r) => (Number(r.id) === Number(reqId) ? request : r)),
    );
    setSelectedRequest((current) =>
      Number(current?.id) === Number(reqId) ? request : current,
    );
    return request;
  }

  function requestUnavailableMessage(request) {
    if (!request) return "This request is no longer available.";
    if (request.status === "Enroute")
      return "Someone is already on the way for this request.";
    if (request.status === "Resolved")
      return "This request has already been resolved.";
    if (request.status === "Cancelled") return "This request was cancelled.";
    return "This request is no longer pending.";
  }

  async function refreshPendingRequest(reqId) {
    const fresh = await getRequest(reqId);
    if (!fresh || fresh.status !== "Pending") {
      removeOpenRequest(reqId);
      alert(requestUnavailableMessage(fresh));
      return null;
    }
    return syncOpenRequest(reqId, fresh);
  }

  function isRequestStatusRace(err) {
    return err?.operation === "accept_request" && err?.contractCode === 3;
  }

  async function buildPrivacyProof({
    scope,
    lat,
    lng,
    campaignId,
    address,
    radiusMeters = 3000,
  }) {
    const zone = buildLocationProofZone({ lat, lng, radiusMeters });
    setZkStatus("proving");
    setZkError("");
    setZkLogs([]);
    pushZkLog("Preparing private witness");
    const proof = await generateLocationProof({
      lat,
      lng,
      campaignId,
      recipientAddress: address,
      zone,
      onLog: pushZkLog,
    });
    const checkpoint = {
      scope,
      campaignId,
      nullifier: proof.nullifier,
      proof,
      zone,
      createdAt: new Date().toISOString(),
    };
    setZkProof(checkpoint);
    setZkStatus("proved");
    pushZkLog("Private location proof ready");
    return checkpoint;
  }

  async function recordZkCheckpoint(address, action, txHash, checkpoint) {
    if (!checkpoint?.nullifier) return;
    try {
      setZkStatus("recording");
      pushZkLog("Writing proof fingerprint to Stellar");
      const record = await recordExpertVerification(
        address,
        action,
        txHash || "",
        checkpoint.nullifier,
        StellarWalletsKit,
      );
      setZkProof((prev) =>
        prev ? { ...prev, recordTxHash: record.hash || "" } : prev,
      );
      setZkStatus("recorded");
      pushZkLog("Stellar checkpoint recorded");
    } catch (err) {
      setZkStatus("proved");
      pushZkLog(
        `Checkpoint record skipped: ${err.message || "wallet rejected"}`,
      );
    }
  }

  async function handleSubmit() {
    if (!validLocation()) {
      setSubmitError("Set your location first.");
      return;
    }
    if (!emergencyType) {
      setSubmitError("Select what happened.");
      return;
    }
    const address = activeWalletAddress || (await promptWalletConnection());
    if (!address) {
      setSubmitError("Connect your Stellar wallet first.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    resetZkCheckpoint();
    try {
      await ensureAccountFunded(address);
      // [Optimize] Overhaul campaignId to eliminate silent failure on network timeouts
      let campaignId;
      try {
        campaignId = await Promise.race([
          Promise.resolve(proofCampaignId(`request:${address}:${Date.now()}`)),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 5000),
          ),
        ]);
      } catch (e) {
        throw new Error("campaignId network timeout");
      }
      const checkpoint = await buildPrivacyProof({
        scope: "Private request",
        lat: location[0],
        lng: location[1],
        campaignId,
        address,
        radiusMeters: 3000,
      });
      const publicLocation = anonymizeLocation(location);
      const { requestId: id, hash } = await createRequest(
        address,
        publicLocation[0],
        publicLocation[1],
        emergencyType,
        "",
        "",
        StellarWalletsKit,
      );
      setRequestId(id);
      setRequestStatus("Pending");
      saveMyRequestId(id);
      // Draft submitted successfully — clear crash recovery data
      clearCrashDraft().catch(() => {});
      setDraftBanner("dismissed");
      setZkProof((prev) =>
        prev ? { ...prev, requestId: id, txHash: hash } : prev,
      );
      await recordZkCheckpoint(
        address,
        "private_request_proof",
        hash,
        checkpoint,
      );
    } catch (err) {
      setZkStatus("error");
      setZkError(err.message || "ZK proof failed");
      setSubmitError("Could not send. " + (err.message || ""));
    }
    setSubmitting(false);
  }

  // [Redesign] Overhaul handleCancel to fix insecure local storage access
  const handleCancel = useCallback(
    async (requestId) => {
      const address = activeWalletAddress;
      if (!address) return;
      setShowCancelConfirm(null);
      // [Refactor] Overhaul prevStatus to prevent stale closures causing ghost renders
      const prevStatus = requestStatus;
      try {
        await cancelRequest(address, requestId, StellarWalletsKit);
        setRequestStatus("Cancelled");
      } catch (err) {
        setRequestStatus(prevStatus);
      }
    },
    [
      activeWalletAddress,
      requestStatus,
      setShowCancelConfirm,
      setRequestStatus,
    ],
  );

  async function handleOffer(req) {
    if (handleOfferBusy.current) return;
    if (!validLocation()) {
      alert(
        "Enable your location first so the requester can see you on the map.",
      );
      return;
    }
    const reqId = Number(req.id);
    if (!Number.isFinite(reqId)) {
      alert("Invalid request");
      return;
    }
    const fresh = await refreshPendingRequest(reqId);
    if (!fresh) return;
    const address = activeWalletAddress || (await promptWalletConnection());
    if (!address) return;

    handleOfferBusy.current = true;
    const seq = ++handleOfferSeq.current;
    const curLocation = [...location];
    setOfferSubmitting(true);
    resetZkCheckpoint();
    try {
      await ensureAccountFunded(address);
      if (seq !== handleOfferSeq.current || !handleOfferMounted.current) return;
      const checkpoint = await buildPrivacyProof({
        scope: "Private responder",
        lat: curLocation[0],
        lng: curLocation[1],
        campaignId: proofCampaignId(`offer:${reqId}`),
        address,
        radiusMeters: 3000,
      });
      if (seq !== handleOfferSeq.current || !handleOfferMounted.current) return;
      const latest = await refreshPendingRequest(reqId);
      if (!latest) {
        pushZkLog("Request changed before Stellar confirmation");
        setZkStatus("proved");
        return;
      }
      const eta = Math.round(Math.random() * 480 + 180);
      const publicLocation = [...anonymizeLocation(curLocation)];
      const result = await acceptRequest(
        address,
        reqId,
        publicLocation[0],
        publicLocation[1],
        eta,
        StellarWalletsKit,
      );
      if (!handleOfferMounted.current) return;
      setSelectedRequest(null);
      setLastOfferReceipt({
        requestId: reqId,
        label: privateRequestLabel(reqId),
        emergencyType: latest.emergency_type,
        txHash: result.hash || "",
        proofId: checkpoint.nullifier,
        at: new Date().toISOString(),
      });
      setZkProof((prev) =>
        prev ? { ...prev, requestId: reqId, txHash: result.hash || "" } : prev,
      );
      await recordZkCheckpoint(
        address,
        "private_responder_proof",
        result.hash || "",
        checkpoint,
      );
      if (!handleOfferMounted.current) return;
      setOpenRequests((prev) => prev.filter((r) => r.id !== reqId));
      if (latest.lat != null && latest.lng != null) {
        setRequesterLocation([latest.lat, latest.lng]);
      }
    } catch (err) {
      if (!handleOfferMounted.current) return;
      if (isRequestStatusRace(err)) {
        removeOpenRequest(reqId);
        setZkStatus("proved");
        setZkError("");
        pushZkLog("Request is no longer pending");
        alert(err.message);
        return;
      }
      setZkStatus("error");
      setZkError(err.message || "ZK proof failed");
      alert("Could not accept request: " + (err.message || ""));
    } finally {
      if (handleOfferMounted.current) setOfferSubmitting(false);
      handleOfferBusy.current = false;
    }
  }

  async function handleMarkArrived() {
    if (!lastOfferReceipt || arrivalSubmitting) return;
    setArrivalSubmitting(true);
    try {
      const result = await markArrived(
        activeWalletAddress,
        lastOfferReceipt.requestId,
        StellarWalletsKit,
      );
      setResponderArrived(true);
      setLastOfferReceipt((prev) =>
        prev
          ? { ...prev, arrivalTxHash: result?.hash || prev.arrivalTxHash || "" }
          : prev,
      );
      setArrivalThanksOpen(true);
    } catch (err) {
      alert("Could not mark arrived: " + (err.message || ""));
    } finally {
      setArrivalSubmitting(false);
    }
  }

  useEffect(() => {
    if (!requestId) return;
    let mounted = true;

    async function poll() {
      try {
        const count = await getResponderCount(requestId);
        let found = false;
        for (let i = 0; i < count; i++) {
          const r = await getResponder(requestId, i);
          if (!r) continue;
          found = true;
          if (mounted) {
            setResponders((prev) => {
              const idx = prev.findIndex((p) => p.responder === r.responder);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = r;
                return next;
              }
              return [...prev, r];
            });
            setRequestStatus("Enroute");
            setTrackingIndex(i);
            if (r.arrived) setResponderArrived(true);
          }
        }
        if (!found && mounted) {
          setResponders([]);
        }
      } catch (_) {}
    }

    poll();
    const interval = setInterval(poll, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [requestId]);

  useEffect(() => {
    if (!lastOfferReceipt || responderArrived) return;
    let mounted = true;
    async function ping() {
      if (!validLocation()) return;
      try {
        await updateLocation(
          activeWalletAddress,
          lastOfferReceipt.requestId,
          location[0],
          location[1],
        );
      } catch (_) {}
    }
    ping();
    const interval = setInterval(ping, 5000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [
    lastOfferReceipt?.requestId,
    location?.[0],
    location?.[1],
    responderArrived,
  ]);

  useEffect(() => {
    if (!lastOfferReceipt) return;
    let mounted = true;
    async function fetchRequester() {
      try {
        const req = await getRequest(lastOfferReceipt.requestId);
        if (mounted && req && req.lat != null && req.lng != null) {
          setRequesterLocation([req.lat, req.lng]);
        }
      } catch {}
    }
    fetchRequester();
    const interval = setInterval(fetchRequester, 8000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [lastOfferReceipt?.requestId]);

  useEffect(() => {
    if (!activeWalletAddress) {
      setMyRequests([]);
      return;
    }
    let mounted = true;
    async function fetchMyRequests() {
      const ids = loadMyRequestIds();
      if (ids.length === 0) {
        if (mounted) setMyRequests([]);
        return;
      }
      setMyRequestsLoading(true);
      try {
        const results = await Promise.all(
          ids.map((id) => getRequest(id).catch(() => null)),
        );
        const filtered = results.filter(
          (r) => r && r.requester === activeWalletAddress,
        );
        filtered.sort((a, b) => b.created_at - a.created_at);
        if (mounted) setMyRequests(filtered);
      } catch (_) {}
      if (mounted) setMyRequestsLoading(false);
    }
    fetchMyRequests();
    const interval = setInterval(fetchMyRequests, 10000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [activeWalletAddress]);

  useEffect(() => {
    setTrackingRequestId(null);
    setTrackingIndex(null);
    setResponderArrived(false);
    setResponders([]);
  }, [mode, requestId]);

  const step1Done = !!location;
  const step2Done = !!emergencyType;
  const step3Done = true;
  const currentStep = !step1Done
    ? 1
    : requestStatus === "idle"
      ? !step2Done
        ? 2
        : 4
      : 5;

  const myChar = selectedChar || pickChar("default", profile.nickname || "me");

  const statusConfig = {
    Pending: {
      label: "WAITING FOR RESPONDER",
      color: "#a2a586",
      bg: "rgba(162,165,134,0.12)",
      msg: "Your pin is live. Waiting for someone nearby.",
    },
    Enroute: {
      label: "RESPONDER ON THE WAY",
      color: "#7357FF",
      bg: "rgba(115,87,255,0.12)",
      msg: "Stay where you are. Help is coming.",
    },
    Resolved: {
      label: "RESOLVED",
      color: "#3F8487",
      bg: "rgba(63,132,135,0.12)",
      msg: "This request has been resolved.",
    },
    Cancelled: {
      label: "CANCELLED",
      color: "#a2a586",
      bg: "rgba(162,165,134,0.12)",
      msg: "Request cancelled.",
    },
  };
  const statusInfo = statusConfig[requestStatus];

  const isGetMode = mode === "get";
  const accentColor = isGetMode ? "#FF7A6B" : "#7357FF";

  const showTracking =
    (requestStatus === "Enroute" && responders.length > 0) ||
    (lastOfferReceipt && !responderArrived);

  const S = {
    input: {
      width: "100%",
      padding: "9px 11px",
      background: "rgba(255,255,255,0.08)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "8px",
      color: "rgba(242,236,220,0.9)",
      fontSize: "13px",
      outline: "none",
      boxSizing: "border-box",
    },
    btnGhost: {
      padding: "8px 12px",
      background: "rgba(255,255,255,0.08)",
      color: "rgba(242,236,220,0.8)",
      border: "1px solid rgba(255,255,255,0.15)",
      borderRadius: "8px",
      fontSize: "12px",
      cursor: "pointer",
      width: "100%",
    },
    errorMsg: { fontSize: "11px", color: "#FF7A6B", marginTop: "6px" },
    divider: {
      borderTop: "1px solid rgba(255,255,255,0.07)",
      margin: "16px 0",
    },
  };

  return (
    <div
      id="helphone-help-wrap"
      className={styles["hp-help-wrap"]}
      style={{
        display: "flex",
        height: "100vh",
        fontFamily: "'Inter','Helvetica Neue',sans-serif",
      }}
    >
      <aside
        ref={sidebarRef}
        id="helphone-help-sidebar"
        className={cx(styles["hp-help-sidebar"], showMobileForm && styles["hp-mobile-open"])}
        style={{
          width: "340px",
          minWidth: "340px",
          background: "#234B4E",
          color: "rgba(242,236,220,0.9)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          zIndex: 1000,
          boxShadow: "4px 0 32px rgba(0,0,0,0.25)",
        }}
      >
        <div style={{ padding: "20px 20px 36px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "20px",
            }}
          >
            <Link
              to="/"
              style={{
                fontFamily: "'Instrument Serif',serif",
                fontSize: "20px",
                textDecoration: "none",
                display: "flex",
              }}
            >
              <span style={{ color: "#F4ECDC", fontStyle: "italic" }}>Hel</span>
              <span style={{ color: "#a2a586" }}>Phone</span>
            </Link>
            <Link
              to="/"
              style={{
                fontSize: "12px",
                color: "rgba(242,236,220,0.35)",
                textDecoration: "none",
              }}
            >
              ← Back
            </Link>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "6px",
              marginBottom: "24px",
              background: "rgba(0,0,0,0.2)",
              borderRadius: "10px",
              padding: "4px",
            }}
          >
            {[
              ["get", "Get Help", "#FF7A6B"],
              ["offer", "Offer Help", "#7357FF"],
            ].map(([m, label, color]) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setSelectedRequest(null);
                  setEmergencyType(null);
                  setRequestStatus("idle");
                  setRequestId(null);
                  if (!isWalletConnected) promptWalletConnection();
                }}
                style={{
                  padding: "10px 0",
                  borderRadius: "7px",
                  border: "none",
                  background: mode === m ? color : "transparent",
                  color: mode === m ? "#fff" : "rgba(242,236,220,0.45)",
                  fontWeight: "600",
                  fontSize: "13px",
                  cursor: "pointer",
                  transition: "all 0.2s",
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div
            style={{
              padding: "12px 13px",
              borderRadius: "12px",
              marginBottom: "18px",
              background:
                "linear-gradient(135deg, rgba(115,87,255,0.16), rgba(63,132,135,0.12))",
              border: "1px solid rgba(179,166,255,0.22)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                marginBottom: "8px",
              }}
            >
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  flexShrink: 0,
                  background:
                    zkStatus === "error"
                      ? "#FF7A6B"
                      : zkStatus === "idle"
                        ? "rgba(242,236,220,0.28)"
                        : "#B3A6FF",
                  animation:
                    zkStatus === "proving" || zkStatus === "recording"
                      ? "mdblink 1.2s steps(1) infinite"
                      : "none",
                }}
              />
              <span
                style={{
                  fontSize: "11px",
                  fontWeight: 900,
                  letterSpacing: "1.25px",
                  color: "#B3A6FF",
                }}
              >
                ZK PRIVACY CHECKPOINT
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  padding: "2px 7px",
                  borderRadius: "999px",
                  background: "rgba(255,255,255,0.08)",
                  color:
                    zkStatus === "error" ? "#FF7A6B" : "rgba(242,236,220,0.62)",
                  fontSize: "9px",
                  fontWeight: 800,
                  letterSpacing: "0.6px",
                  textTransform: "uppercase",
                }}
              >
                {zkStatus === "idle" ? "ready" : zkStatus}
              </span>
            </div>
            <p
              style={{
                margin: "0 0 8px",
                fontSize: "11px",
                color: "rgba(242,236,220,0.52)",
                lineHeight: 1.45,
              }}
            >
              Exact location stays private. Stellar sees a proof fingerprint, a
              zone, and a pseudonymous wallet action.
            </p>
            {zkProof?.nullifier && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "7px",
                  marginBottom: "8px",
                }}
              >
                <div
                  style={{
                    padding: "7px 8px",
                    borderRadius: "8px",
                    background: "rgba(0,0,0,0.16)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "8px",
                      letterSpacing: "0.9px",
                      color: "rgba(242,236,220,0.28)",
                      marginBottom: "3px",
                    }}
                  >
                    NULLIFIER
                  </div>
                  <div
                    style={{
                      fontSize: "10px",
                      color: "#F4ECDC",
                      fontFamily: "'Courier New', monospace",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {shortProofId(zkProof.nullifier)}
                  </div>
                </div>
                <div
                  style={{
                    padding: "7px 8px",
                    borderRadius: "8px",
                    background: "rgba(0,0,0,0.16)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <div
                    style={{
                      fontSize: "8px",
                      letterSpacing: "0.9px",
                      color: "rgba(242,236,220,0.28)",
                      marginBottom: "3px",
                    }}
                  >
                    ZONE
                  </div>
                  <div style={{ fontSize: "10px", color: "#F4ECDC" }}>
                    {zkProof.zone?.radiusMeters
                      ? `${Math.round(zkProof.zone.radiusMeters / 1000)} km private box`
                      : "private box"}
                  </div>
                </div>
              </div>
            )}
            {(zkProof?.txHash || zkProof?.recordTxHash) && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "4px",
                  marginBottom: "6px",
                }}
              >
                {zkProof?.txHash && (
                  <ExplorerLink label="On-chain action" hash={zkProof.txHash} />
                )}
                {zkProof?.recordTxHash && (
                  <ExplorerLink
                    label="Proof record"
                    hash={zkProof.recordTxHash}
                  />
                )}
              </div>
            )}
            {zkError && (
              <div
                style={{
                  fontSize: "10px",
                  color: "#FF7A6B",
                  lineHeight: 1.35,
                  marginBottom: "6px",
                }}
              >
                {zkError}
              </div>
            )}
            {zkLogs.length > 0 && (
              <div
                style={{ display: "flex", flexDirection: "column", gap: "3px" }}
              >
                {zkLogs.slice(-3).map((line, i) => (
                  <div
                    key={`${line}-${i}`}
                    style={{
                      fontSize: "9.5px",
                      color: "rgba(242,236,220,0.34)",
                      lineHeight: 1.35,
                    }}
                  >
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>

          <NetworkStatusIndicator />

          {isGetMode && (
            <>
              {draftBanner === "found" && (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "10px",
                    background: "rgba(63,132,135,0.14)",
                    border: "1px solid rgba(63,132,135,0.35)",
                    borderRadius: "10px",
                    padding: "10px 12px",
                    marginBottom: "14px",
                  }}
                >
                  <span style={{ fontSize: "16px", lineHeight: 1 }}>💾</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "12px",
                        fontWeight: 700,
                        color: "#7fb8ba",
                        marginBottom: "2px",
                      }}
                    >
                      Draft restored
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: "rgba(242,236,220,0.55)",
                        lineHeight: 1.5,
                      }}
                    >
                      Your previous form data was recovered after the page
                      closed.
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss draft banner"
                    onClick={() => {
                      setDraftBanner("dismissed");
                      clearCrashDraft().catch(() => {});
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "rgba(242,236,220,0.4)",
                      cursor: "pointer",
                      fontSize: "14px",
                      lineHeight: 1,
                      padding: "2px 4px",
                      flexShrink: 0,
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}
              {requestStatus === "idle" ? (
                <div style={{ marginBottom: "20px" }}>
                  <h2
                    style={{
                      margin: 0,
                      fontFamily: "'Instrument Serif',serif",
                      fontWeight: 400,
                      fontSize: "20px",
                      color: "#F4ECDC",
                      lineHeight: 1.2,
                    }}
                  >
                    Request help nearby
                  </h2>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "rgba(242,236,220,0.4)",
                      lineHeight: 1.5,
                    }}
                  >
                    Fill in the steps below. Nearby people will be notified.
                  </p>
                </div>
              ) : (
                <div
                  style={{
                    padding: "12px 14px",
                    borderRadius: "10px",
                    marginBottom: "20px",
                    background: statusInfo?.bg,
                    border: `1px solid ${statusInfo?.color}44`,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "5px",
                    }}
                  >
                    <span
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: statusInfo?.color,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: "700",
                        letterSpacing: "1.5px",
                        color: statusInfo?.color,
                      }}
                    >
                      {statusInfo?.label}
                    </span>
                    {requestStatus === "Enroute" &&
                      responders[0]?.eta_seconds && (
                        <span
                          style={{
                            marginLeft: "auto",
                            fontSize: "12px",
                            color: "rgba(242,236,220,0.5)",
                          }}
                        >
                          ETA {Math.round(responders[0].eta_seconds / 60)} min
                        </span>
                      )}
                  </div>
                  <p
                    style={{
                      margin: 0,
                      fontSize: "12px",
                      color: "rgba(242,236,220,0.45)",
                      lineHeight: 1.4,
                    }}
                  >
                    {statusInfo?.msg}
                  </p>
                  {requestStatus === "Enroute" && responders[0] && (
                    <div
                      style={{
                        marginTop: "8px",
                        padding: "8px 10px",
                        borderRadius: "8px",
                        background: "rgba(115,87,255,0.08)",
                        border: "1px solid rgba(115,87,255,0.2)",
                      }}
                    >
                      <div
                        style={{
                          fontSize: "10px",
                          fontWeight: 600,
                          color: "#B3A6FF",
                          marginBottom: "4px",
                        }}
                      >
                        RESPONDER {responderArrived ? "ARRIVED ✓" : "EN ROUTE"}
                      </div>
                      <div
                        style={{
                          fontSize: "11px",
                          color: "rgba(242,236,220,0.65)",
                          lineHeight: 1.5,
                        }}
                      >
                        {responders[0].responder?.slice(0, 8)}…
                        {responders[0].eta_seconds && !responderArrived && (
                          <>
                            {" "}
                            · ETA {Math.round(
                              responders[0].eta_seconds / 60,
                            )}{" "}
                            min
                          </>
                        )}
                        {location && responders[0] && (
                          <>
                            {" "}
                            ·{" "}
                            {Math.round(
                              distance(location, [
                                responders[0].lat,
                                responders[0].lng,
                              ]) * 10,
                            ) / 10}{" "}
                            km away
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <Step
                n="1"
                title="Your location"
                subtitle={
                  locating
                    ? "Requesting…"
                    : location
                      ? `${location[0].toFixed(4)}, ${location[1].toFixed(4)}`
                      : "Not set"
                }
                done={step1Done}
                active={
                  currentStep === 1 || (!step1Done && requestStatus === "idle")
                }
              >
                {requestStatus === "idle" && (
                  <>
                    {locating && (
                      <p
                        style={{
                          fontSize: "12px",
                          color: "rgba(242,236,220,0.45)",
                          margin: "0 0 8px",
                        }}
                      >
                        Asking for your location…
                      </p>
                    )}
                    {locationError && (
                      <p
                        style={{
                          fontSize: "12px",
                          color: "#FF7A6B",
                          margin: "0 0 8px",
                          lineHeight: 1.4,
                        }}
                      >
                        {locationError}
                      </p>
                    )}
                    {!locating && !location && (
                      <button
                        style={{ ...S.btnGhost, marginBottom: "8px" }}
                        onClick={requestLocation}
                      >
                        Allow location access
                      </button>
                    )}
                    {location && (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "6px",
                          padding: "7px 10px",
                          borderRadius: "8px",
                          background: "rgba(63,132,135,0.15)",
                          border: "1px solid rgba(63,132,135,0.3)",
                          marginBottom: "8px",
                        }}
                      >
                        <span style={{ fontSize: "12px", color: "#3F8487" }}>
                          Location set ✓
                        </span>
                        <button
                          onClick={requestLocation}
                          style={{
                            marginLeft: "auto",
                            background: "none",
                            border: "none",
                            color: "rgba(242,236,220,0.35)",
                            fontSize: "11px",
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          refresh
                        </button>
                      </div>
                    )}
                    <form
                      ref={searchBoxRef}
                      onSubmit={handleSearch}
                      style={{
                        display: "flex",
                        gap: "6px",
                        position: "relative",
                      }}
                    >
                      <input
                        style={S.input}
                        placeholder="Or search city, country…"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleSearchKeyDown}
                        autoComplete="off"
                        role="combobox"
                        aria-expanded={searchSuggestions.length > 0}
                        aria-controls="hp-search-suggestions"
                        aria-activedescendant={
                          activeSuggestion >= 0
                            ? `hp-suggestion-${activeSuggestion}`
                            : undefined
                        }
                      />
                      <button
                        type="submit"
                        style={{
                          padding: "9px 12px",
                          background: "#FF7A6B",
                          color: "#fff",
                          border: "none",
                          borderRadius: "8px",
                          fontSize: "13px",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                        disabled={searchLoading}
                      >
                        {searchLoading ? "…" : "Go"}
                      </button>
                      {(searchSuggestions.length > 0 || searchSuggestLoading) &&
                        searchQuery.trim() && (
                          <div
                            id="hp-search-suggestions"
                            role="listbox"
                            style={{
                              position: "absolute",
                              top: "calc(100% + 6px)",
                              left: 0,
                              right: 0,
                              zIndex: 20,
                              background: "#1c2c24",
                              border: "1px solid rgba(255,255,255,0.08)",
                              borderRadius: "10px",
                              overflow: "hidden",
                              boxShadow: "0 10px 28px rgba(0,0,0,0.35)",
                            }}
                          >
                            {searchSuggestLoading && (
                              <div
                                style={{
                                  padding: "10px 12px",
                                  fontSize: "11px",
                                  color: "rgba(242,236,220,0.35)",
                                }}
                              >
                                Searching references...
                              </div>
                            )}
                            {searchSuggestions.map((feature, idx) => (
                              <button
                                key={feature.id}
                                id={`hp-suggestion-${idx}`}
                                role="option"
                                aria-selected={idx === activeSuggestion}
                                type="button"
                                onClick={() => selectSearchSuggestion(feature)}
                                onMouseMove={() => setActiveSuggestion(idx)}
                                style={{
                                  width: "100%",
                                  padding: "10px 12px",
                                  border: "none",
                                  background:
                                    idx === activeSuggestion
                                      ? "rgba(255,255,255,0.07)"
                                      : "transparent",
                                  color: "rgba(242,236,220,0.9)",
                                  textAlign: "left",
                                  cursor: "pointer",
                                  display: "block",
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: "12px",
                                    fontWeight: 600,
                                    lineHeight: 1.3,
                                  }}
                                >
                                  {feature.place_name}
                                </div>
                                <div
                                  style={{
                                    fontSize: "10px",
                                    color: "rgba(242,236,220,0.34)",
                                    marginTop: "2px",
                                  }}
                                >
                                  {feature.place_type?.join(" · ") ||
                                    "reference"}
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                    </form>
                    {searchError && <p style={S.errorMsg}>{searchError}</p>}
                    {!location && (
                      <p
                        style={{
                          fontSize: "11px",
                          color: "rgba(242,236,220,0.3)",
                          margin: "6px 0 0",
                        }}
                      >
                        You can also click the map to drop a pin.
                      </p>
                    )}
                  </>
                )}
              </Step>

              <Step
                n="2"
                title="What happened?"
                subtitle={
                  step2Done
                    ? EMERGENCY_TYPES.find((e) => e.id === emergencyType)?.label
                    : "Select one"
                }
                done={step2Done}
                active={currentStep === 2 && requestStatus === "idle"}
              >
                {requestStatus === "idle" && !step2Done && (
                  <button
                    onClick={() => setShowEmergencyModal(true)}
                    style={{
                      ...S.btnGhost,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <span>Pick a type</span>
                    <span style={{ fontSize: "16px", opacity: 0.5 }}>›</span>
                  </button>
                )}
                {requestStatus === "idle" &&
                  step2Done &&
                  (() => {
                    const et = EMERGENCY_TYPES.find(
                      (e) => e.id === emergencyType,
                    );
                    return (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          padding: "10px 12px",
                          background: "rgba(255,255,255,0.05)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "12px",
                        }}
                      >
                        <div
                          style={{
                            width: "40px",
                            height: "40px",
                            borderRadius: "10px",
                            background: "#FF7A6B",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                            color: "#fff",
                          }}
                        >
                          {ET_ICONS[et.id]}
                        </div>
                        <span
                          style={{
                            fontSize: "13px",
                            fontWeight: "600",
                            color: "#F4ECDC",
                            flex: 1,
                          }}
                        >
                          {et.label}
                        </span>
                        <button
                          onClick={() => setShowEmergencyModal(true)}
                          style={{
                            background: "none",
                            border: "none",
                            color: "rgba(242,236,220,0.35)",
                            fontSize: "12px",
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            gap: "2px",
                            padding: "4px",
                          }}
                        >
                          Change <span style={{ fontSize: "14px" }}>›</span>
                        </button>
                      </div>
                    );
                  })()}
              </Step>

              <Step
                n="3"
                title="Your info"
                subtitle={
                  step3Done
                    ? `${profile.nickname} · ${profile.contact}`
                    : "Optional — how responders reach you"
                }
                done={step3Done}
                active={currentStep === 3 && requestStatus === "idle"}
              >
                {requestStatus === "idle" && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      marginTop: "4px",
                    }}
                  >
                    <input
                      style={S.input}
                      placeholder="Nickname or name"
                      maxLength={30}
                      value={profile.nickname}
                      onChange={(e) =>
                        setProfile((p) => ({ ...p, nickname: e.target.value }))
                      }
                    />
                    <input
                      style={S.input}
                      placeholder="@telegram or +54 11 5555-5555"
                      maxLength={40}
                      value={profile.contact}
                      onChange={(e) =>
                        setProfile((p) => ({ ...p, contact: e.target.value }))
                      }
                    />
                    <div
                      style={{
                        fontSize: "9.5px",
                        color: "rgba(242,236,220,0.18)",
                        lineHeight: 1.4,
                      }}
                    >
                      How responders reach you. Stored on-chain.
                    </div>
                  </div>
                )}
              </Step>

              <Step
                n="4"
                title="Send request"
                subtitle={
                  step1Done && step2Done
                    ? "Ready to go"
                    : "Complete the steps above"
                }
                done={requestStatus !== "idle"}
                active={currentStep === 4 && requestStatus === "idle"}
              >
                {requestStatus === "idle" && (
                  <>
                    <p
                      style={{
                        fontSize: "11px",
                        color: "rgba(242,236,220,0.35)",
                        margin: "0 0 10px",
                        lineHeight: 1.5,
                      }}
                    >
                      Your pin appears on the map. People nearby will see your
                      request and reach out.
                    </p>
                    <button
                      onClick={handleSubmit}
                      disabled={submitting || !step1Done || !step2Done}
                      style={{
                        width: "100%",
                        padding: "13px",
                        background:
                          step1Done && step2Done && isWalletConnected
                            ? "#FF7A6B"
                            : "rgba(255,255,255,0.08)",
                        color:
                          step1Done && step2Done && isWalletConnected
                            ? "#fff"
                            : "rgba(242,236,220,0.25)",
                        border: "none",
                        borderRadius: "10px",
                        fontSize: "15px",
                        fontWeight: "600",
                        cursor: step1Done && step2Done ? "pointer" : "default",
                        opacity: submitting ? 0.6 : 1,
                        transition: "all 0.2s",
                      }}
                    >
                      {submitting
                        ? "Sending…"
                        : !isWalletConnected
                          ? "Connect wallet first"
                          : "Request help"}
                    </button>
                    {submitError && <p style={S.errorMsg}>{submitError}</p>}
                  </>
                )}
              </Step>
            </>
          )}

          {!isGetMode && (
            <>
              <div style={{ marginBottom: "20px" }}>
                <h2
                  style={{
                    margin: 0,
                    fontFamily: "'Instrument Serif',serif",
                    fontWeight: 400,
                    fontSize: "20px",
                    color: "#F4ECDC",
                    lineHeight: 1.2,
                  }}
                >
                  People who need help
                </h2>
                <p
                  style={{
                    margin: 0,
                    fontSize: "12px",
                    color: "rgba(242,236,220,0.4)",
                    lineHeight: 1.5,
                  }}
                >
                  {openRequests.length === 0
                    ? "No one nearby needs help right now."
                    : `${openRequests.length} active request${openRequests.length > 1 ? "s" : ""} on the map. Tap a pin to help.`}
                </p>
              </div>

              {lastOfferReceipt && (
                <div
                  style={{
                    padding: "12px 13px",
                    borderRadius: "10px",
                    marginBottom: "14px",
                    background: "rgba(115,87,255,0.12)",
                    border: "1px solid rgba(115,87,255,0.28)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "6px",
                    }}
                  >
                    <span
                      style={{
                        width: "8px",
                        height: "8px",
                        borderRadius: "50%",
                        background: "#7357FF",
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        fontSize: "11px",
                        fontWeight: 800,
                        letterSpacing: "1.2px",
                        color: "#B3A6FF",
                      }}
                    >
                      HELP REGISTERED
                    </span>
                  </div>
                  <p
                    style={{
                      margin: "0 0 9px",
                      fontSize: "12px",
                      color: "rgba(242,236,220,0.52)",
                      lineHeight: 1.45,
                    }}
                  >
                    You are helping {lastOfferReceipt.label || "this person"}.
                    Your location is being shared with them.
                  </p>
                  {lastOfferReceipt.txHash && (
                    <div style={{ marginBottom: "9px" }}>
                      <ExplorerLink
                        label="On-chain action"
                        hash={lastOfferReceipt.txHash}
                      />
                    </div>
                  )}
                  <div style={{ display: "flex", gap: "8px" }}>
                    {responderArrived ? (
                      <div
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: "8px",
                          background: "rgba(63,132,135,0.15)",
                          color: "#3F8487",
                          fontSize: "11px",
                          fontWeight: 800,
                          textAlign: "center",
                          border: "1px solid rgba(63,132,135,0.3)",
                        }}
                      >
                        ARRIVED ✓
                      </div>
                    ) : (
                      <button
                        onClick={handleMarkArrived}
                        disabled={arrivalSubmitting}
                        style={{
                          flex: 1,
                          padding: "8px 10px",
                          borderRadius: "8px",
                          border: "1px solid rgba(63,132,135,0.25)",
                          background: "rgba(63,132,135,0.12)",
                          color: "#3F8487",
                          fontSize: "11px",
                          fontWeight: 800,
                          cursor: arrivalSubmitting ? "default" : "pointer",
                          opacity: arrivalSubmitting ? 0.7 : 1,
                        }}
                      >
                        {arrivalSubmitting ? "Recording..." : "Mark Arrived"}
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div style={S.divider} />

              {selectedRequest ? (
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "14px",
                    }}
                  >
                    <img
                      src={`/assets/chars/${pickChar("default", selectedRequest.id)}.png`}
                      style={{
                        width: "44px",
                        height: "44px",
                        objectFit: "contain",
                      }}
                      alt=""
                    />
                    <div>
                      <div
                        style={{
                          fontSize: "14px",
                          fontWeight: "600",
                          color: "#F4ECDC",
                        }}
                      >
                        {selectedRequest.nickname || "Anonymous"}
                      </div>
                      {(() => {
                        const et = EMERGENCY_TYPES.find(
                          (e) => e.id === selectedRequest.emergency_type,
                        );
                        return et ? (
                          <div
                            style={{
                              fontSize: "11px",
                              color: "rgba(242,236,220,0.5)",
                              marginTop: "2px",
                            }}
                          >
                            {et.icon} {et.label}
                          </div>
                        ) : null;
                      })()}
                      <div
                        style={{
                          fontSize: "11px",
                          color: "rgba(242,236,220,0.4)",
                        }}
                      >
                        {selectedRequest.contact || ""}
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedRequest(null)}
                      style={{
                        marginLeft: "auto",
                        background: "none",
                        border: "none",
                        color: "rgba(242,236,220,0.35)",
                        fontSize: "18px",
                        cursor: "pointer",
                      }}
                    >
                      ×
                    </button>
                  </div>

                  {selectedRequest.status === "Pending" ? (
                    <button
                      onClick={() => handleOffer(selectedRequest)}
                      disabled={offerSubmitting || !location}
                      style={{
                        width: "100%",
                        padding: "13px",
                        background: isWalletConnected
                          ? "#7357FF"
                          : "rgba(255,255,255,0.08)",
                        color: isWalletConnected
                          ? "#fff"
                          : "rgba(242,236,220,0.25)",
                        border: "none",
                        borderRadius: "10px",
                        fontSize: "15px",
                        fontWeight: "600",
                        cursor: location ? "pointer" : "default",
                        opacity: offerSubmitting ? 0.6 : 1,
                      }}
                    >
                      {offerSubmitting
                        ? "Confirming…"
                        : !isWalletConnected
                          ? "Connect wallet first"
                          : "I'll help this person"}
                    </button>
                  ) : (
                    <div
                      style={{
                        width: "100%",
                        padding: "13px",
                        borderRadius: "10px",
                        fontSize: "14px",
                        fontWeight: "600",
                        textAlign: "center",
                        background: "rgba(115,87,255,0.12)",
                        color: "#7357FF",
                      }}
                    >
                      Someone is already on the way
                    </div>
                  )}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      marginTop: "8px",
                      color: "rgba(242,236,220,0.34)",
                      fontSize: "11px",
                      lineHeight: 1.45,
                    }}
                  >
                    <span>
                      Helping creates your own public receipt after Stellar
                      confirms.
                    </span>
                  </div>
                  {!location && (
                    <p style={S.errorMsg}>
                      Enable your location so they can see you on the map.
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <div
                    style={{
                      fontSize: "11px",
                      letterSpacing: "1.5px",
                      fontWeight: "600",
                      color: "#3F8487",
                      marginBottom: "10px",
                    }}
                  >
                    ACTIVE REQUESTS
                  </div>
                  {openRequests.length === 0 ? (
                    <p
                      style={{
                        fontSize: "12px",
                        color: "rgba(242,236,220,0.3)",
                        lineHeight: 1.5,
                      }}
                    >
                      No one nearby needs help right now. Check back soon.
                    </p>
                  ) : (
                    openRequests.map((req) => (
                      <button
                        key={req.id}
                        onClick={() => setSelectedRequest(req)}
                        style={{
                          width: "100%",
                          marginBottom: "8px",
                          padding: "10px 12px",
                          background: "rgba(255,255,255,0.06)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "10px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          gap: "10px",
                          textAlign: "left",
                        }}
                      >
                        <img
                          src={`/assets/chars/${pickChar("default", req.id)}.png`}
                          style={{
                            width: "36px",
                            height: "36px",
                            objectFit: "contain",
                            flexShrink: 0,
                          }}
                          alt=""
                        />
                        <div>
                          <div
                            style={{
                              fontSize: "13px",
                              fontWeight: "600",
                              color: "#F4ECDC",
                            }}
                          >
                            {req.nickname || "Anonymous"}
                          </div>
                          {(() => {
                            const et = EMERGENCY_TYPES.find(
                              (e) => e.id === req.emergency_type,
                            );
                            return et ? (
                              <div
                                style={{
                                  fontSize: "10px",
                                  color: "rgba(242,236,220,0.3)",
                                  marginTop: "1px",
                                }}
                              >
                                {et.icon} {et.label}
                              </div>
                            ) : null;
                          })()}
                        </div>
                        <div
                          style={{
                            marginLeft: "auto",
                            width: "8px",
                            height: "8px",
                            borderRadius: "50%",
                            background: "#FF7A6B",
                            flexShrink: 0,
                          }}
                        />
                      </button>
                    ))
                  )}
                </div>
              )}
            </>
          )}

          {isWalletConnected && (
            <>
              <div style={S.divider} />
              <div>
                <div
                  style={{
                    fontSize: "11px",
                    letterSpacing: "1.5px",
                    fontWeight: "600",
                    color: "#3F8487",
                    marginBottom: "10px",
                  }}
                >
                  MY REQUESTS{" "}
                  {myRequests.length > 0 && (
                    <span style={{ color: "rgba(242,236,220,0.3)" }}>
                      ({myRequests.length})
                    </span>
                  )}
                </div>
                {myRequestsLoading && myRequests.length === 0 ? (
                  <p
                    style={{ fontSize: "12px", color: "rgba(242,236,220,0.3)" }}
                  >
                    Loading...
                  </p>
                ) : myRequests.length === 0 ? (
                  <p
                    style={{ fontSize: "12px", color: "rgba(242,236,220,0.3)" }}
                  >
                    You haven&apos;t requested help yet.
                  </p>
                ) : (
                  myRequests.slice(0, 10).map((req) => {
                    const isActive = req.id === requestId;
                    const statusColors = {
                      Pending: {
                        color: "#a2a586",
                        bg: "rgba(162,165,134,0.15)",
                      },
                      Enroute: {
                        color: "#7357FF",
                        bg: "rgba(115,87,255,0.15)",
                      },
                      Resolved: {
                        color: "#3F8487",
                        bg: "rgba(63,132,135,0.15)",
                      },
                      Cancelled: {
                        color: "rgba(242,236,220,0.3)",
                        bg: "rgba(255,255,255,0.04)",
                      },
                    };
                    const sc =
                      statusColors[req.status] || statusColors.Cancelled;
                    const et = EMERGENCY_TYPES.find(
                      (e) => e.id === req.emergency_type,
                    );
                    const timeAgo = req.created_at
                      ? (() => {
                          const d = Math.floor(
                            (Date.now() / 1000 - req.created_at) / 60,
                          );
                          return d < 1
                            ? "just now"
                            : d < 60
                              ? `${d}m ago`
                              : `${Math.floor(d / 60)}h ago`;
                        })()
                      : "";
                    return (
                      <div
                        key={req.id}
                        onClick={() => {
                          if (
                            req.status === "Pending" ||
                            req.status === "Enroute"
                          ) {
                            setRequestId(req.id);
                            setRequestStatus(req.status);
                          }
                        }}
                        style={{
                          padding: "10px 12px",
                          marginBottom: "8px",
                          borderRadius: "10px",
                          cursor: "pointer",
                          background: isActive
                            ? "rgba(63,132,135,0.12)"
                            : "rgba(255,255,255,0.04)",
                          border: isActive
                            ? "1px solid rgba(63,132,135,0.3)"
                            : "1px solid rgba(255,255,255,0.06)",
                          transition: "background 0.15s",
                        }}
                        onMouseEnter={(e) => {
                          if (!isActive)
                            e.currentTarget.style.background =
                              "rgba(255,255,255,0.07)";
                        }}
                        onMouseLeave={(e) => {
                          if (!isActive)
                            e.currentTarget.style.background =
                              "rgba(255,255,255,0.04)";
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: "8px",
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "6px",
                                flexWrap: "wrap",
                              }}
                            >
                              <span
                                style={{
                                  fontSize: "12px",
                                  fontWeight: "600",
                                  color: "#F4ECDC",
                                }}
                              >
                                #{req.id}
                              </span>
                              <span
                                style={{
                                  fontSize: "9px",
                                  fontWeight: "700",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  background: sc.bg,
                                  color: sc.color,
                                  letterSpacing: "0.5px",
                                }}
                              >
                                {req.status?.toUpperCase()}
                              </span>
                            </div>
                            <div
                              style={{
                                fontSize: "10px",
                                color: "rgba(242,236,220,0.35)",
                                marginTop: "3px",
                                lineHeight: 1.4,
                              }}
                            >
                              {et
                                ? `${et.icon} ${et.label}`
                                : req.emergency_type || "Unknown"}
                              {timeAgo && (
                                <span
                                  style={{
                                    marginLeft: "6px",
                                    color: "rgba(242,236,220,0.2)",
                                  }}
                                >
                                  · {timeAgo}
                                </span>
                              )}
                            </div>
                          </div>
                          {isActive && req.status === "Pending" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setShowCancelConfirm(req.id);
                              }}
                              style={{
                                padding: "5px 9px",
                                borderRadius: "6px",
                                flexShrink: 0,
                                background: "rgba(255,122,107,0.12)",
                                border: "1px solid rgba(255,122,107,0.25)",
                                color: "#FF7A6B",
                                fontSize: "10px",
                                fontWeight: "700",
                                cursor: "pointer",
                                lineHeight: 1,
                              }}
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </>
          )}
        </div>
      </aside>

      <div id="helphone-help-map" className={styles["hp-help-main"]} style={{ flex: 1, position: "relative" }}>
        <Map
          mapboxAccessToken={MAPBOX_TOKEN}
          initialViewState={{
            longitude: DEFAULT_CENTER[1],
            latitude: DEFAULT_CENTER[0],
            zoom: 2,
          }}
          style={{ width: "100%", height: "100%" }}
          mapStyle={MAP_STYLES[mapStyleIndex].url}
          onClick={(e) => {
            if (isGetMode && requestStatus === "idle") {
              setLocation([e.lngLat.lat, e.lngLat.lng]);
            }
          }}
        >
          {location && <MapController center={location} zoom={14} />}
          <NavigationControl position="bottom-right" />

          {isGetMode && location && (
            <CharMarker
              charName={myChar}
              accentColor="#FF7A6B"
              lat={location[0]}
              lng={location[1]}
              onClick={() =>
                setPopupMarker((p) => (p === "user" ? null : "user"))
              }
            >
              {popupMarker === "user" && (
                <Popup
                  latitude={location[0]}
                  longitude={location[1]}
                  onClose={() => setPopupMarker(null)}
                  closeButton={false}
                >
                  <strong style={{ color: "#FF7A6B" }}>You</strong>
                  {profile.nickname && (
                    <>
                      <br />
                      {profile.nickname}
                    </>
                  )}
                </Popup>
              )}
            </CharMarker>
          )}

          {!isGetMode && location && (
            <CharMarker
              charName={myChar}
              accentColor="#7357FF"
              lat={location[0]}
              lng={location[1]}
              onClick={() =>
                setPopupMarker((p) =>
                  p === "responder-me" ? null : "responder-me",
                )
              }
            >
              {popupMarker === "responder-me" && (
                <Popup
                  latitude={location[0]}
                  longitude={location[1]}
                  onClose={() => setPopupMarker(null)}
                  closeButton={false}
                >
                  <strong style={{ color: "#7357FF" }}>You (responder)</strong>
                  {profile.nickname && (
                    <>
                      <br />
                      {profile.nickname}
                    </>
                  )}
                </Popup>
              )}
            </CharMarker>
          )}

          {isGetMode &&
            location &&
            responders.map((r) => (
              <Fragment key={r.id}>
                <CharMarker
                  charName={pickChar("default", r.responder)}
                  accentColor="#7357FF"
                  lat={r.lat}
                  lng={r.lng}
                  onClick={() =>
                    setPopupMarker((p) =>
                      p === `resp-${r.id}` ? null : `resp-${r.id}`,
                    )
                  }
                >
                  {popupMarker === `resp-${r.id}` && (
                    <Popup
                      latitude={r.lat}
                      longitude={r.lng}
                      onClose={() => setPopupMarker(null)}
                      closeButton={false}
                    >
                      <strong style={{ color: "#7357FF" }}>Responder</strong>
                      <br />
                      <span style={{ fontSize: "11px", color: "#a2a586" }}>
                        {r.responder
                          ? r.responder.slice(0, 8) + "…"
                          : "Responder"}
                      </span>
                      {r.eta_seconds && (
                        <>
                          <br />
                          ETA: {Math.round(r.eta_seconds / 60)} min
                        </>
                      )}
                    </Popup>
                  )}
                </CharMarker>
                <RouteLine id={r.id} from={[r.lat, r.lng]} to={location} />
              </Fragment>
            ))}

          {!isGetMode &&
            openRequests.map((req) => (
              <CharMarker
                key={req.id}
                charName={pickChar("default", req.id)}
                accentColor="#FF7A6B"
                lat={req.lat}
                lng={req.lng}
                onClick={() => {
                  setSelectedRequest(req);
                  setPopupMarker(`req-${req.id}`);
                }}
              >
                {popupMarker === `req-${req.id}` && (
                  <Popup
                    latitude={req.lat}
                    longitude={req.lng}
                    onClose={() => setPopupMarker(null)}
                    closeButton={false}
                  >
                    <strong style={{ color: "#FF7A6B" }}>
                      {req.nickname || "Anonymous"}
                    </strong>
                    <br />
                    <span style={{ fontSize: "11px", color: "#a2a586" }}>
                      Needs help · Click sidebar to respond
                    </span>
                  </Popup>
                )}
              </CharMarker>
            ))}

          {showTracking && isGetMode && responders[0] && (
            <TrackingScreen
              responderLat={responders[0].lat}
              responderLng={responders[0].lng}
              responderAddress={responders[0].responder}
              responderChar={pickChar("default", responders[0].responder)}
              requesterLat={location?.[0]}
              requesterLng={location?.[1]}
              requesterChar={myChar}
              etaSeconds={responders[0].eta_seconds}
              isArrived={responderArrived}
              isResponderView={false}
              onResolve={async () => {
                try {
                  await resolveRequest(
                    activeWalletAddress,
                    requestId,
                    StellarWalletsKit,
                  );
                  setRequestStatus("Resolved");
                } catch (err) {
                  alert("Could not resolve: " + (err.message || ""));
                }
              }}
            />
          )}

          {showTracking &&
            !isGetMode &&
            lastOfferReceipt &&
            location &&
            requesterLocation && (
              <TrackingScreen
                responderLat={location[0]}
                responderLng={location[1]}
                responderAddress={activeWalletAddress}
                responderChar={myChar}
                requesterLat={requesterLocation[0]}
                requesterLng={requesterLocation[1]}
                requesterChar={pickChar("default", lastOfferReceipt.nickname)}
                etaSeconds={null}
                isArrived={responderArrived}
                isResponderView={true}
                isMarkingArrived={arrivalSubmitting}
                onMarkArrived={handleMarkArrived}
              />
            )}
        </Map>

        <div
          ref={styleSelectorRef}
          style={{
            position: "absolute",
            top: "12px",
            left: "12px",
            zIndex: 10,
          }}
        >
          <button
            onClick={() => setStyleOpen((o) => !o)}
            style={{
              padding: "7px 14px",
              background: "#234B4E",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "20px",
              color: "rgba(242,236,220,0.85)",
              fontSize: "12px",
              fontWeight: "600",
              cursor: "pointer",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              gap: "7px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            }}
          >
            <span
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: "#7357FF",
                flexShrink: 0,
              }}
            />
            {MAP_STYLES[mapStyleIndex].name}{" "}
            <span style={{ opacity: 0.5 }}>▾</span>
          </button>
          {styleOpen && (
            <div
              style={{
                marginTop: "6px",
                background: "#1c2c24",
                borderRadius: "12px",
                border: "1px solid rgba(255,255,255,0.08)",
                overflow: "hidden",
                boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
                minWidth: "220px",
              }}
            >
              {MAP_STYLES.map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setMapStyleIndex(i);
                    setStyleOpen(false);
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 14px",
                    border: "none",
                    borderBottom:
                      i < MAP_STYLES.length - 1
                        ? "1px solid rgba(255,255,255,0.05)"
                        : "none",
                    background:
                      i === mapStyleIndex
                        ? "rgba(115,87,255,0.12)"
                        : "transparent",
                    color:
                      i === mapStyleIndex ? "#B3A6FF" : "rgba(242,236,220,0.7)",
                    cursor: "pointer",
                    textAlign: "left",
                    display: "block",
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background =
                      "rgba(255,255,255,0.05)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background =
                      i === mapStyleIndex
                        ? "rgba(115,87,255,0.12)"
                        : "transparent")
                  }
                >
                  <div
                    style={{
                      fontSize: "13px",
                      fontWeight: 600,
                      marginBottom: "2px",
                    }}
                  >
                    {s.name}
                  </div>
                  <div
                    style={{
                      fontSize: "11px",
                      color: "rgba(242,236,220,0.35)",
                      lineHeight: 1.4,
                    }}
                  >
                    {s.desc}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          aria-label="Open HelPhone help guide"
          onClick={() => setShowOnboarding(true)}
          style={{
            position: "absolute",
            top: "12px",
            right: "68px",
            zIndex: 10,
            width: "44px",
            height: "44px",
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.12)",
            background: "#234B4E",
            color: "#F4ECDC",
            fontSize: "18px",
            fontWeight: 900,
            cursor: "pointer",
            boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
            backdropFilter: "blur(8px)",
          }}
        >
          ?
        </button>

        <div
          ref={profileRef}
          style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            zIndex: 10,
          }}
        >
          <button
            onClick={() => {
              if (isWalletConnected) {
                setProfileOpen((o) => !o);
                return;
              }
              promptWalletConnection();
            }}
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "50%",
              padding: 0,
              cursor: "pointer",
              background:
                profile.nickname || isWalletConnected
                  ? "#234B4E"
                  : "rgba(35,75,78,0.55)",
              border: `2px solid ${isWalletConnected ? "rgba(115,87,255,0.4)" : "rgba(255,255,255,0.12)"}`,
              overflow: "hidden",
              backdropFilter: "blur(8px)",
              boxShadow: isWalletConnected
                ? "0 0 0 3px rgba(115,87,255,0.15), 0 4px 16px rgba(0,0,0,0.3)"
                : "0 4px 16px rgba(0,0,0,0.3)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {profile.nickname || isWalletConnected ? (
              <img
                src={`/assets/chars/${myChar}.png`}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
                alt=""
              />
            ) : (
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="rgba(242,236,220,0.5)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
              </svg>
            )}
          </button>

          {profileOpen && isWalletConnected && (
            <div
              style={{
                position: "absolute",
                top: "52px",
                right: "0",
                width: "300px",
                background: "#1c2c24",
                borderRadius: "16px",
                border: "1px solid rgba(255,255,255,0.08)",
                overflow: "hidden",
                boxShadow: "0 12px 48px rgba(0,0,0,0.6)",
              }}
            >
              <div
                style={{
                  padding: "20px 20px 16px",
                  background: "rgba(115,87,255,0.06)",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: "14px" }}
                >
                  <div
                    style={{
                      width: "52px",
                      height: "52px",
                      borderRadius: "12px",
                      overflow: "hidden",
                      background: "#234B4E",
                      flexShrink: 0,
                      border: "2px solid rgba(115,87,255,0.3)",
                    }}
                  >
                    <img
                      src={`/assets/chars/${myChar}.png`}
                      style={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        display: "block",
                      }}
                      alt=""
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "15px",
                        fontWeight: 600,
                        color: "#F4ECDC",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {profile.nickname || "Anonymous"}
                    </div>
                    <div
                      style={{
                        fontSize: "11px",
                        color: "rgba(242,236,220,0.35)",
                        marginTop: "2px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {activeWalletAddress.slice(0, 8)}...
                      {activeWalletAddress.slice(-6)}
                    </div>
                  </div>
                  <button
                    onClick={async () => {
                      await StellarWalletsKit.disconnect();
                      setWalletAddress("");
                      setProfileOpen(false);
                    }}
                    style={{
                      background: "rgba(255,255,255,0.06)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "8px",
                      color: "rgba(242,236,220,0.35)",
                      fontSize: "13px",
                      cursor: "pointer",
                      padding: "6px 8px",
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>

              <div style={{ padding: "14px 20px 6px" }}>
                <div style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "5px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "rgba(242,236,220,0.5)",
                      }}
                    >
                      On-chain alias
                    </div>
                    {profile.nickname && (
                      <div
                        style={{
                          fontSize: "9px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "rgba(63,132,135,0.15)",
                          color: "#3F8487",
                          letterSpacing: "0.5px",
                        }}
                      >
                        SET
                      </div>
                    )}
                  </div>
                  <input
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "8px",
                      color: "rgba(242,236,220,0.9)",
                      fontSize: "13px",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                    placeholder="Anonymous"
                    maxLength={20}
                    value={profile.nickname}
                    onChange={(e) =>
                      setProfile((p) => ({ ...p, nickname: e.target.value }))
                    }
                  />
                  <div
                    style={{
                      fontSize: "9.5px",
                      color: "rgba(242,236,220,0.18)",
                      marginTop: "4px",
                      lineHeight: 1.4,
                    }}
                  >
                    A pseudonym reveals nothing. No on-chain storage — it exists
                    only in this session.
                  </div>
                </div>

                <div style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: "5px",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "11px",
                        fontWeight: 600,
                        color: "rgba(242,236,220,0.5)",
                      }}
                    >
                      Contact
                    </div>
                    {profile.contact && (
                      <div
                        style={{
                          fontSize: "9px",
                          padding: "2px 6px",
                          borderRadius: "4px",
                          background: "rgba(63,132,135,0.15)",
                          color: "#3F8487",
                          letterSpacing: "0.5px",
                        }}
                      >
                        SET
                      </div>
                    )}
                  </div>
                  <input
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      background: "rgba(255,255,255,0.05)",
                      border: "1px solid rgba(255,255,255,0.08)",
                      borderRadius: "8px",
                      color: "rgba(242,236,220,0.9)",
                      fontSize: "13px",
                      outline: "none",
                      boxSizing: "border-box",
                    }}
                    placeholder="@telegram or +54 11 5555-5555"
                    maxLength={40}
                    value={profile.contact}
                    onChange={(e) =>
                      setProfile((p) => ({ ...p, contact: e.target.value }))
                    }
                  />
                  <div
                    style={{
                      fontSize: "9.5px",
                      color: "rgba(242,236,220,0.18)",
                      marginTop: "4px",
                      lineHeight: 1.4,
                    }}
                  >
                    How responders reach you. Stored on-chain.
                  </div>
                </div>

                <div style={{ marginBottom: "14px" }}>
                  <div
                    style={{
                      fontSize: "11px",
                      fontWeight: 600,
                      color: "rgba(242,236,220,0.5)",
                      marginBottom: "6px",
                    }}
                  >
                    Map avatar{" "}
                    <span
                      style={{
                        fontWeight: 400,
                        color: "rgba(242,236,220,0.2)",
                      }}
                    >
                      · tap to override auto-pick
                    </span>
                  </div>
                  <div
                    style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}
                  >
                    {CHARS.default.map((name) => (
                      <button
                        key={name}
                        onClick={() =>
                          setSelectedChar((c) => (c === name ? null : name))
                        }
                        style={{
                          width: "40px",
                          height: "40px",
                          padding: 0,
                          borderRadius: "8px",
                          overflow: "hidden",
                          cursor: "pointer",
                          background:
                            myChar === name
                              ? "rgba(115,87,255,0.15)"
                              : "rgba(255,255,255,0.03)",
                          border:
                            myChar === name
                              ? "2px solid #7357FF"
                              : "2px solid rgba(255,255,255,0.06)",
                        }}
                      >
                        <img
                          src={`/assets/chars/${name}.png`}
                          style={{
                            width: "100%",
                            height: "100%",
                            objectFit: "contain",
                            display: "block",
                          }}
                          alt=""
                        />
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <HelpOnboardingModal
          open={showOnboarding}
          onClose={() => setShowOnboarding(false)}
          onConnectWallet={() => promptWalletConnection()}
        />

        {!location && (
          <div
            id="hp-hint-overlay"
            style={{
              position: "absolute",
              bottom: "24px",
              left: "50%",
              transform: "translateX(-50%)",
              background: "#234B4E",
              color: "rgba(242,236,220,0.8)",
              padding: "10px 18px",
              borderRadius: "24px",
              fontSize: "13px",
              fontWeight: "500",
              boxShadow: "0 4px 20px rgba(0,0,0,0.25)",
              pointerEvents: "none",
              zIndex: 999,
              whiteSpace: "nowrap",
            }}
          >
            {locating
              ? "Getting your location…"
              : isGetMode
                ? "Allow location or click map to drop your pin"
                : "Enable location to show responders where you are"}
          </div>
        )}

        <button
          id="hp-mobile-form-toggle"
          onClick={() => setShowMobileForm((o) => !o)}
          style={{
            position: "absolute",
            bottom: "20px",
            right: "20px",
            zIndex: 100,
            width: "50px",
            height: "50px",
            borderRadius: "50%",
            padding: 0,
            background: "#FF7A6B",
            border: "none",
            cursor: "pointer",
            boxShadow: "0 4px 20px rgba(255,122,107,0.5)",
            display: "none",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {showMobileForm ? (
              <polyline points="18 15 12 9 6 15" />
            ) : (
              <polyline points="6 9 12 15 18 9" />
            )}
          </svg>
        </button>
      </div>

      <ArrivalThanksModal
        open={arrivalThanksOpen}
        onClose={() => setArrivalThanksOpen(false)}
        requestLabel={lastOfferReceipt?.label}
        txHash={lastOfferReceipt?.arrivalTxHash}
      />

      {showCancelConfirm !== null && (
        <div
          onClick={() => setShowCancelConfirm(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1c3535",
              borderRadius: "20px",
              padding: "28px 24px 20px",
              width: "100%",
              maxWidth: "360px",
              textAlign: "center",
              boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
            }}
          >
            <div style={{ fontSize: "32px", marginBottom: "12px" }}>⚠️</div>
            <h3
              style={{
                margin: "0 0 6px",
                fontSize: "18px",
                fontWeight: "700",
                color: "#F4ECDC",
              }}
            >
              Cancel request
            </h3>
            <p
              style={{
                margin: "0 0 20px",
                fontSize: "13px",
                color: "rgba(242,236,220,0.5)",
                lineHeight: 1.5,
              }}
            >
              Are you sure? Request #{showCancelConfirm} will be recorded as
              cancelled on Stellar.
            </p>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={() => setShowCancelConfirm(null)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "1px solid rgba(255,255,255,0.08)",
                  background: "rgba(255,255,255,0.05)",
                  color: "rgba(242,236,220,0.72)",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                onClick={() => handleCancel(showCancelConfirm)}
                style={{
                  flex: 1,
                  padding: "10px",
                  borderRadius: "10px",
                  border: "none",
                  background: "#FF7A6B",
                  color: "#fff",
                  fontSize: "13px",
                  fontWeight: "700",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showEmergencyModal && (
        <div
          onClick={() => setShowEmergencyModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.65)",
            zIndex: 9999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "20px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#1c3535",
              borderRadius: "20px",
              padding: "24px",
              width: "100%",
              maxWidth: "400px",
              maxHeight: "85vh",
              overflowY: "auto",
              boxShadow: "0 24px 64px rgba(0,0,0,0.55)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                marginBottom: "20px",
              }}
            >
              <div>
                <h2
                  style={{
                    margin: 0,
                    fontSize: "22px",
                    fontWeight: "700",
                    color: "#F4ECDC",
                    lineHeight: 1.2,
                  }}
                >
                  What happened?
                </h2>
                <p
                  style={{
                    margin: "6px 0 0",
                    fontSize: "13px",
                    color: "rgba(242,236,220,0.4)",
                    lineHeight: 1.4,
                  }}
                >
                  Pick one so the right people are notified.
                </p>
              </div>
              <button
                onClick={() => setShowEmergencyModal(false)}
                style={{
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  border: "none",
                  flexShrink: 0,
                  marginLeft: "12px",
                  background: "rgba(255,255,255,0.1)",
                  color: "rgba(242,236,220,0.7)",
                  fontSize: "18px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ×
              </button>
            </div>
            <div
              style={{ display: "flex", flexDirection: "column", gap: "8px" }}
            >
              {EMERGENCY_TYPES.map((et) => {
                const isSelected = emergencyType === et.id;
                return (
                  <button
                    key={et.id}
                    onClick={() => {
                      setEmergencyType(et.id);
                      setSubmitError("");
                      setShowEmergencyModal(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "14px",
                      width: "100%",
                      padding: "14px",
                      background: isSelected
                        ? "rgba(255,122,107,0.08)"
                        : "rgba(255,255,255,0.04)",
                      border: `1.5px solid ${isSelected ? "#FF7A6B" : "rgba(255,255,255,0.08)"}`,
                      borderRadius: "14px",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "border-color 0.15s, background 0.15s",
                    }}
                  >
                    <div
                      style={{
                        width: "48px",
                        height: "48px",
                        borderRadius: "12px",
                        flexShrink: 0,
                        background: isSelected
                          ? "#FF7A6B"
                          : "rgba(255,255,255,0.08)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: isSelected ? "#fff" : "rgba(242,236,220,0.65)",
                        transition: "background 0.15s",
                      }}
                    >
                      {ET_ICONS[et.id]}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: "15px",
                          fontWeight: "600",
                          color: "#F4ECDC",
                          marginBottom: "2px",
                        }}
                      >
                        {et.label}
                      </div>
                      <div
                        style={{
                          fontSize: "12px",
                          color: "rgba(242,236,220,0.35)",
                          lineHeight: 1.3,
                        }}
                      >
                        {et.desc}
                      </div>
                    </div>
                    {isSelected && (
                      <div
                        style={{
                          width: "24px",
                          height: "24px",
                          borderRadius: "50%",
                          flexShrink: 0,
                          background: "#FF7A6B",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                        >
                          <polyline
                            points="2,6 5,9 10,3"
                            stroke="#fff"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 768px) {
          #helphone-help-wrap { position: relative; }
          #helphone-help-sidebar {
            position: fixed !important;
            bottom: 0 !important;
            left: 0 !important;
            width: 100% !important;
            min-width: 0 !important;
            max-height: 70vh !important;
            border-radius: 20px 20px 0 0 !important;
            box-shadow: 0 -8px 40px rgba(0,0,0,0.35) !important;
            transform: translateY(calc(100% - 50px)) !important;
            transition: transform 0.35s cubic-bezier(0.22, 0.75, 0.2, 1) !important;
            z-index: 2000 !important;
          }
          #helphone-help-sidebar.${styles["hp-mobile-open"]} {
            transform: translateY(0) !important;
          }
          #helphone-help-sidebar::before {
            content: '';
            display: block;
            width: 36px;
            height: 4px;
            border-radius: 2px;
            background: rgba(255,255,255,0.15);
            margin: 10px auto 0;
          }
          #helphone-help-map { height: 100vh !important; flex: none !important; }
          #hp-mobile-form-toggle { display: flex !important; }
          #helphone-help-sidebar > div { padding-top: 8px !important; }
          #hp-hint-overlay { bottom: 80px !important; font-size: 12px !important; padding: 8px 14px !important; max-width: calc(100vw - 40px) !important; overflow: hidden !important; text-overflow: ellipsis !important; }
        }
      `}</style>
    </div>
  );
}
