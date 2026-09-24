/**
 * OffscreenCanvas overlay rendering for the community map.
 *
 * Animated markers (pulsing rings) are drawn on a <canvas> whose control is
 * transferred to a Web Worker via `transferControlToOffscreen()`, so the
 * animation runs on its own thread and cannot be starved by React renders or
 * map interaction on the main thread. Browsers without OffscreenCanvas get the
 * same drawing on the main thread through the identical `drawOverlayFrame`.
 *
 * The frame rate is driven by requestAnimationFrame (display refresh, typically
 * 60 Hz) and *measured*, not assumed: `FpsMeter` reports what was achieved so a
 * slow device is visible instead of silently claimed to be at 60 FPS.
 */
import type { MapOverlay, OverlayKind, OverlayRenderStats } from '../types';

export const TARGET_FPS = 60;
export const STATS_INTERVAL_MS = 1_000;

export const OVERLAY_COLORS: Record<OverlayKind, string> = {
  pending: '#FF7A6B',
  enroute: '#7357FF',
  resolved: '#3F8487',
  responder: '#234B4E',
};

const PULSE_PERIOD_MS = 2_000;
const CORE_RADIUS = 6;
const MAX_PULSE_RADIUS = 22;

/** The subset of a 2D context the renderer uses, so tests can fake it. */
export interface DrawContext {
  clearRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  fill(): void;
  stroke(): void;
  save(): void;
  restore(): void;
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  globalAlpha: number;
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
}

export interface RenderSize {
  /** Logical width/height in map (viewBox) units. */
  width: number;
  height: number;
  /** Device pixel ratio the backing store is scaled by. */
  dpr: number;
}

/** Pulse progress 0..1 for a marker at time `t`, staggered per overlay so they don't all beat together. */
export function pulsePhase(t: number, index: number): number {
  return ((t + index * 250) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
}

/** Draw one frame. Pure with respect to its arguments, shared by worker and main thread. */
export function drawOverlayFrame(
  ctx: DrawContext,
  overlays: readonly MapOverlay[],
  size: RenderSize,
  t: number,
): void {
  ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  overlays.forEach((o, i) => {
    const color = OVERLAY_COLORS[o.kind] ?? OVERLAY_COLORS.pending;
    const phase = pulsePhase(t, i);

    ctx.save();
    ctx.globalAlpha = 0.5 * (1 - phase);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(o.x, o.y, CORE_RADIUS + phase * (MAX_PULSE_RADIUS - CORE_RADIUS), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(o.x, o.y, CORE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
}

/** Rolling frame-rate meter: call `tick(now)` once per frame. */
export class FpsMeter {
  private frames = 0;
  private windowStart: number | null = null;
  private lastFps = 0;

  constructor(private readonly intervalMs = STATS_INTERVAL_MS) {}

  /** Returns fresh stats once per interval, otherwise null. */
  tick(now: number): OverlayRenderStats | null {
    if (this.windowStart === null) {
      this.windowStart = now;
      this.frames = 0;
      return null;
    }
    this.frames++;
    const elapsed = now - this.windowStart;
    if (elapsed < this.intervalMs) return null;
    this.lastFps = (this.frames * 1_000) / elapsed;
    const stats = { fps: this.lastFps, frames: this.frames, windowMs: elapsed };
    this.windowStart = now;
    this.frames = 0;
    return stats;
  }

  get fps(): number {
    return this.lastFps;
  }
}

export function isOffscreenCanvasSupported(
  canvas?: { transferControlToOffscreen?: unknown } | null,
  g: { Worker?: unknown; OffscreenCanvas?: unknown } = globalThis as never,
): boolean {
  return (
    typeof g.Worker === 'function' &&
    typeof g.OffscreenCanvas === 'function' &&
    typeof canvas?.transferControlToOffscreen === 'function'
  );
}

export interface OverlayRenderer {
  readonly mode: 'worker' | 'main-thread';
  setOverlays(overlays: MapOverlay[]): void;
  resize(size: RenderSize): void;
  destroy(): void;
}

export interface OverlayRendererOptions extends RenderSize {
  onStats?: (stats: OverlayRenderStats) => void;
  /** Called if the worker fails after control was transferred; the canvas can't be reused, so remount it. */
  onError?: (error: Error) => void;
  /** Skip OffscreenCanvas even when supported (e.g. after a worker failure). */
  forceMainThread?: boolean;
  /** Test seam. Defaults to a module worker running src/workers/canvas-worker.js. */
  createWorker?: () => Worker;
}

type CanvasLike = HTMLCanvasElement & { transferControlToOffscreen(): OffscreenCanvas };

function defaultWorker(): Worker {
  return new Worker(new URL('../workers/canvas-worker.js', import.meta.url), { type: 'module' });
}

function applyBackingStore(canvas: HTMLCanvasElement, size: RenderSize) {
  canvas.width = Math.round(size.width * size.dpr);
  canvas.height = Math.round(size.height * size.dpr);
}

/**
 * Attach an overlay renderer to `canvas`. Uses a worker when OffscreenCanvas is
 * available, otherwise (or when forced) draws on the main thread.
 */
export function createOverlayRenderer(
  canvas: HTMLCanvasElement,
  opts: OverlayRendererOptions,
): OverlayRenderer {
  if (!opts.forceMainThread && isOffscreenCanvasSupported(canvas)) {
    return createWorkerRenderer(canvas as CanvasLike, opts);
  }
  return createMainThreadRenderer(canvas, opts);
}

function createWorkerRenderer(canvas: CanvasLike, opts: OverlayRendererOptions): OverlayRenderer {
  // Size the backing store before handing over control; afterwards only the worker may resize it.
  applyBackingStore(canvas, opts);
  const offscreen = canvas.transferControlToOffscreen();
  const worker = (opts.createWorker ?? defaultWorker)();

  worker.onmessage = (event: MessageEvent) => {
    if (event.data?.type === 'stats') opts.onStats?.(event.data.stats as OverlayRenderStats);
  };
  worker.onerror = (event: ErrorEvent) => {
    opts.onError?.(new Error(event.message || 'Overlay worker failed'));
  };

  worker.postMessage(
    { type: 'init', canvas: offscreen, width: opts.width, height: opts.height, dpr: opts.dpr },
    [offscreen],
  );

  return {
    mode: 'worker',
    setOverlays: (overlays) => worker.postMessage({ type: 'overlays', overlays }),
    resize: (size) => worker.postMessage({ type: 'resize', ...size }),
    destroy: () => {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    },
  };
}

function createMainThreadRenderer(canvas: HTMLCanvasElement, opts: OverlayRendererOptions): OverlayRenderer {
  let size: RenderSize = { width: opts.width, height: opts.height, dpr: opts.dpr };
  let overlays: MapOverlay[] = [];
  let rafId: number | null = null;
  let stopped = false;
  const meter = new FpsMeter();
  const ctx = canvas.getContext('2d') as DrawContext | null;
  applyBackingStore(canvas, size);

  const frame = (now: number) => {
    if (stopped) return;
    if (ctx) drawOverlayFrame(ctx, overlays, size, now);
    const stats = meter.tick(now);
    if (stats) opts.onStats?.(stats);
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);

  return {
    mode: 'main-thread',
    setOverlays: (next) => {
      overlays = next;
    },
    resize: (next) => {
      size = next;
      applyBackingStore(canvas, size);
    },
    destroy: () => {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    },
  };
}
