// OffscreenCanvas overlay renderer (issue #532).
// Owns the transferred canvas and animates map markers off the main thread.
// Message protocol (main -> worker):
//   { type: 'init', canvas: OffscreenCanvas, width, height, dpr }
//   { type: 'overlays', overlays: MapOverlay[] }
//   { type: 'resize', width, height, dpr }
//   { type: 'stop' }
// Worker -> main:
//   { type: 'stats', stats: { fps, frames, windowMs } }   once per second

import { drawOverlayFrame, FpsMeter } from "../lib/offscreenCanvas.ts";

let canvas = null;
let ctx = null;
let size = { width: 0, height: 0, dpr: 1 };
let overlays = [];
let running = false;
const meter = new FpsMeter();

// Dedicated workers expose requestAnimationFrame when an OffscreenCanvas is
// attached; fall back to a ~60Hz timer where it isn't available.
const schedule =
  typeof self.requestAnimationFrame === "function"
    ? (cb) => self.requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(performance.now()), 1000 / 60);

function frame(now) {
  if (!running) return;
  drawOverlayFrame(ctx, overlays, size, now);
  const stats = meter.tick(now);
  if (stats) self.postMessage({ type: "stats", stats });
  schedule(frame);
}

function applySize(next) {
  size = { width: next.width, height: next.height, dpr: next.dpr };
  canvas.width = Math.round(size.width * size.dpr);
  canvas.height = Math.round(size.height * size.dpr);
}

self.onmessage = (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      canvas = msg.canvas;
      ctx = canvas.getContext("2d");
      applySize(msg);
      running = true;
      schedule(frame);
      break;
    case "overlays":
      overlays = msg.overlays;
      break;
    case "resize":
      if (canvas) applySize(msg);
      break;
    case "stop":
      running = false;
      break;
    default:
      break;
  }
};
