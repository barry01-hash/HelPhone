// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TARGET_FPS,
  OVERLAY_COLORS,
  pulsePhase,
  drawOverlayFrame,
  FpsMeter,
  isOffscreenCanvasSupported,
  createOverlayRenderer,
} from '../src/lib/offscreenCanvas.ts';

const SIZE = { width: 1140, height: 540, dpr: 2 };

function fakeCtx() {
  const calls = [];
  const rec = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    setTransform: rec('setTransform'),
    clearRect: rec('clearRect'),
    beginPath: rec('beginPath'),
    arc: rec('arc'),
    fill: rec('fill'),
    stroke: rec('stroke'),
    save: rec('save'),
    restore: rec('restore'),
    globalAlpha: 1,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  };
}

describe('constants', () => {
  it('targets 60 FPS with a color per overlay kind', () => {
    expect(TARGET_FPS).toBe(60);
    expect(Object.keys(OVERLAY_COLORS).sort()).toEqual(['enroute', 'pending', 'resolved', 'responder']);
  });
});

describe('pulsePhase', () => {
  it('stays within [0, 1) and repeats every 2s', () => {
    expect(pulsePhase(0, 0)).toBe(0);
    expect(pulsePhase(1000, 0)).toBe(0.5);
    expect(pulsePhase(2000, 0)).toBe(0);
    for (let t = 0; t < 5000; t += 137) {
      const p = pulsePhase(t, 3);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(1);
    }
  });

  it('staggers overlays so they do not pulse in unison', () => {
    expect(pulsePhase(0, 1)).not.toBe(pulsePhase(0, 0));
  });
});

describe('drawOverlayFrame', () => {
  it('scales for dpr, clears, then draws a ring and a core per overlay', () => {
    const ctx = fakeCtx();
    drawOverlayFrame(ctx, [{ id: 'a', x: 10, y: 20, kind: 'pending' }, { id: 'b', x: 30, y: 40, kind: 'resolved' }], SIZE, 500);
    expect(ctx.calls[0]).toEqual(['setTransform', 2, 0, 0, 2, 0, 0]);
    expect(ctx.calls[1]).toEqual(['clearRect', 0, 0, 1140, 540]);
    expect(ctx.calls.filter((c) => c[0] === 'arc')).toHaveLength(4);
    expect(ctx.calls.filter((c) => c[0] === 'stroke')).toHaveLength(2);
    expect(ctx.calls.filter((c) => c[0] === 'fill')).toHaveLength(2);
    const arcs = ctx.calls.filter((c) => c[0] === 'arc');
    expect(arcs[0].slice(1, 3)).toEqual([10, 20]);
    expect(arcs[2].slice(1, 3)).toEqual([30, 40]);
  });

  it('draws only the clear when there are no overlays', () => {
    const ctx = fakeCtx();
    drawOverlayFrame(ctx, [], SIZE, 0);
    expect(ctx.calls.map((c) => c[0])).toEqual(['setTransform', 'clearRect']);
  });

  it('uses the kind color and falls back to pending for an unknown kind', () => {
    const ctx = fakeCtx();
    const styles = [];
    Object.defineProperty(ctx, 'fillStyle', { set: (v) => styles.push(v), get: () => '' });
    drawOverlayFrame(ctx, [{ id: 'a', x: 0, y: 0, kind: 'enroute' }, { id: 'b', x: 0, y: 0, kind: 'bogus' }], SIZE, 0);
    expect(styles).toEqual([OVERLAY_COLORS.enroute, OVERLAY_COLORS.pending]);
  });

  it('fades the ring as the pulse expands', () => {
    const alphas = [];
    const ctx = fakeCtx();
    Object.defineProperty(ctx, 'globalAlpha', { set: (v) => alphas.push(v), get: () => 1 });
    drawOverlayFrame(ctx, [{ id: 'a', x: 0, y: 0, kind: 'pending' }], SIZE, 0);
    drawOverlayFrame(ctx, [{ id: 'a', x: 0, y: 0, kind: 'pending' }], SIZE, 1500);
    // ring alpha is the first alpha set per frame
    expect(alphas[0]).toBeGreaterThan(alphas[2]);
  });
});

describe('FpsMeter', () => {
  it('reports nothing until a full window has elapsed', () => {
    const m = new FpsMeter(1000);
    expect(m.tick(0)).toBeNull();
    expect(m.tick(500)).toBeNull();
  });

  it('computes ~60 fps from 16.67ms frames', () => {
    const m = new FpsMeter(1000);
    let stats = null;
    for (let i = 0; i <= 61 && !stats; i++) stats = m.tick(i * (1000 / 60));
    expect(stats).not.toBeNull();
    expect(stats.fps).toBeGreaterThan(58);
    expect(stats.fps).toBeLessThanOrEqual(61);
    expect(m.fps).toBe(stats.fps);
  });

  it('exposes a degraded rate rather than hiding it', () => {
    const m = new FpsMeter(1000);
    let stats = null;
    for (let i = 0; i <= 31 && !stats; i++) stats = m.tick(i * 40); // 25 fps
    expect(stats.fps).toBeCloseTo(25, 0);
  });

  it('starts a fresh window after reporting', () => {
    const m = new FpsMeter(100);
    m.tick(0);
    const first = m.tick(100);
    expect(first).not.toBeNull();
    expect(m.tick(150)).toBeNull();
  });
});

describe('isOffscreenCanvasSupported', () => {
  const canvas = { transferControlToOffscreen: () => {} };
  const g = { Worker: function () {}, OffscreenCanvas: function () {} };
  it('requires Worker, OffscreenCanvas and transferControlToOffscreen', () => {
    expect(isOffscreenCanvasSupported(canvas, g)).toBe(true);
    expect(isOffscreenCanvasSupported({}, g)).toBe(false);
    expect(isOffscreenCanvasSupported(null, g)).toBe(false);
    expect(isOffscreenCanvasSupported(canvas, { ...g, Worker: undefined })).toBe(false);
    expect(isOffscreenCanvasSupported(canvas, { ...g, OffscreenCanvas: undefined })).toBe(false);
  });
  it('is false in a plain Node environment', () => {
    expect(isOffscreenCanvasSupported(canvas)).toBe(false);
  });
});

describe('createOverlayRenderer (worker mode)', () => {
  let worker;
  let offscreen;
  let canvas;
  const opts = (extra = {}) => ({ ...SIZE, createWorker: () => worker, ...extra });

  beforeEach(() => {
    vi.stubGlobal('Worker', function () {});
    vi.stubGlobal('OffscreenCanvas', function () {});
    worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null };
    offscreen = { tag: 'offscreen' };
    canvas = { width: 0, height: 0, transferControlToOffscreen: vi.fn(() => offscreen) };
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sizes the backing store, transfers control, and inits the worker with a transfer list', () => {
    const r = createOverlayRenderer(canvas, opts());
    expect(r.mode).toBe('worker');
    expect(canvas.width).toBe(2280);
    expect(canvas.height).toBe(1080);
    expect(canvas.transferControlToOffscreen).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenCalledWith(
      { type: 'init', canvas: offscreen, width: 1140, height: 540, dpr: 2 },
      [offscreen],
    );
  });

  it('forwards overlays, resize and stop; destroy terminates the worker', () => {
    const r = createOverlayRenderer(canvas, opts());
    const overlays = [{ id: 'a', x: 1, y: 2, kind: 'pending' }];
    r.setOverlays(overlays);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'overlays', overlays });
    r.resize({ width: 800, height: 400, dpr: 1 });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'resize', width: 800, height: 400, dpr: 1 });
    r.destroy();
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'stop' });
    expect(worker.terminate).toHaveBeenCalled();
  });

  it('relays worker stats and ignores unrelated messages', () => {
    const onStats = vi.fn();
    createOverlayRenderer(canvas, opts({ onStats }));
    const stats = { fps: 59.8, frames: 60, windowMs: 1003 };
    worker.onmessage({ data: { type: 'stats', stats } });
    worker.onmessage({ data: { type: 'other' } });
    worker.onmessage({ data: null });
    expect(onStats).toHaveBeenCalledTimes(1);
    expect(onStats).toHaveBeenCalledWith(stats);
  });

  it('reports worker failures through onError', () => {
    const onError = vi.fn();
    createOverlayRenderer(canvas, opts({ onError }));
    worker.onerror({ message: 'boom' });
    worker.onerror({});
    expect(onError.mock.calls[0][0].message).toBe('boom');
    expect(onError.mock.calls[1][0].message).toBe('Overlay worker failed');
  });

  it('does not require stats/error callbacks', () => {
    createOverlayRenderer(canvas, opts());
    expect(() => {
      worker.onmessage({ data: { type: 'stats', stats: {} } });
      worker.onerror({ message: 'x' });
    }).not.toThrow();
  });

  it('uses the main thread when forced, without touching transferControlToOffscreen', () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    canvas.getContext = () => fakeCtx();
    const r = createOverlayRenderer(canvas, opts({ forceMainThread: true }));
    expect(r.mode).toBe('main-thread');
    expect(canvas.transferControlToOffscreen).not.toHaveBeenCalled();
    r.destroy();
  });
});

describe('createOverlayRenderer (main-thread fallback)', () => {
  let raf;
  let ctx;
  let canvas;
  let queue;

  beforeEach(() => {
    queue = [];
    raf = vi.fn((cb) => { queue.push(cb); return queue.length; });
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    ctx = fakeCtx();
    canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx) };
  });
  afterEach(() => vi.unstubAllGlobals());

  const step = (now) => { const cb = queue.shift(); cb(now); };

  it('falls back when OffscreenCanvas is unsupported', () => {
    const r = createOverlayRenderer(canvas, SIZE);
    expect(r.mode).toBe('main-thread');
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    expect(canvas.width).toBe(2280);
    r.destroy();
  });

  it('draws each frame with the latest overlays and reschedules', () => {
    const r = createOverlayRenderer(canvas, SIZE);
    r.setOverlays([{ id: 'a', x: 5, y: 6, kind: 'pending' }]);
    step(100);
    expect(ctx.calls.some((c) => c[0] === 'arc' && c[1] === 5 && c[2] === 6)).toBe(true);
    expect(queue).toHaveLength(1);
    r.destroy();
  });

  it('reports stats once a window elapses', () => {
    const onStats = vi.fn();
    const r = createOverlayRenderer(canvas, { ...SIZE, onStats });
    for (let i = 0; i <= 62; i++) step(i * (1000 / 60));
    expect(onStats).toHaveBeenCalled();
    expect(onStats.mock.calls[0][0].fps).toBeGreaterThan(55);
    r.destroy();
  });

  it('resizes the backing store', () => {
    const r = createOverlayRenderer(canvas, SIZE);
    r.resize({ width: 100, height: 50, dpr: 1 });
    expect([canvas.width, canvas.height]).toEqual([100, 50]);
    r.destroy();
  });

  it('stops drawing and cancels the frame on destroy', () => {
    const r = createOverlayRenderer(canvas, SIZE);
    r.destroy();
    const before = ctx.calls.length;
    step(0);
    expect(ctx.calls.length).toBe(before);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('survives a canvas that cannot provide a 2d context', () => {
    canvas.getContext = () => null;
    const r = createOverlayRenderer(canvas, SIZE);
    expect(() => step(0)).not.toThrow();
    r.destroy();
  });
});

describe('canvas-worker message protocol', () => {
  let scope;
  let rafQueue;
  let ctx;
  let offscreen;

  async function load() {
    vi.resetModules();
    await import('../src/workers/canvas-worker.js');
    return scope.onmessage;
  }

  beforeEach(() => {
    rafQueue = [];
    ctx = fakeCtx();
    offscreen = { width: 0, height: 0, getContext: vi.fn(() => ctx) };
    scope = {
      postMessage: vi.fn(),
      requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    };
    vi.stubGlobal('self', scope);
  });
  afterEach(() => vi.unstubAllGlobals());

  const init = (handle) => handle({ data: { type: 'init', canvas: offscreen, ...SIZE } });
  const frame = (now) => rafQueue.shift()(now);

  it('init sizes the canvas, takes its 2d context and starts the loop', async () => {
    const handle = await load();
    init(handle);
    expect(offscreen.width).toBe(2280);
    expect(offscreen.height).toBe(1080);
    expect(offscreen.getContext).toHaveBeenCalledWith('2d');
    expect(rafQueue).toHaveLength(1);
  });

  it('draws received overlays each frame and keeps scheduling', async () => {
    const handle = await load();
    init(handle);
    handle({ data: { type: 'overlays', overlays: [{ id: 'a', x: 7, y: 8, kind: 'enroute' }] } });
    frame(16);
    expect(ctx.calls.some((c) => c[0] === 'arc' && c[1] === 7 && c[2] === 8)).toBe(true);
    expect(rafQueue).toHaveLength(1);
  });

  it('posts measured fps stats roughly once a second', async () => {
    const handle = await load();
    init(handle);
    for (let i = 0; i <= 62; i++) frame(i * (1000 / 60));
    const posted = scope.postMessage.mock.calls.map((c) => c[0]).filter((m) => m.type === 'stats');
    expect(posted.length).toBeGreaterThanOrEqual(1);
    expect(posted[0].stats.fps).toBeGreaterThan(55);
  });

  it('resize updates the backing store; resize before init is ignored', async () => {
    const handle = await load();
    expect(() => handle({ data: { type: 'resize', width: 10, height: 10, dpr: 1 } })).not.toThrow();
    init(handle);
    handle({ data: { type: 'resize', width: 100, height: 50, dpr: 1 } });
    expect([offscreen.width, offscreen.height]).toEqual([100, 50]);
  });

  it('stop halts the loop and unknown messages are ignored', async () => {
    const handle = await load();
    init(handle);
    handle({ data: { type: 'whatever' } });
    handle({ data: { type: 'stop' } });
    const before = ctx.calls.length;
    frame(16);
    expect(ctx.calls.length).toBe(before);
    expect(rafQueue).toHaveLength(0);
  });

  it('falls back to a ~60Hz timer when requestAnimationFrame is unavailable', async () => {
    vi.useFakeTimers();
    delete scope.requestAnimationFrame;
    const handle = await load();
    init(handle);
    await vi.advanceTimersByTimeAsync(40);
    expect(ctx.calls.some((c) => c[0] === 'clearRect')).toBe(true);
    handle({ data: { type: 'stop' } });
    vi.useRealTimers();
  });
});
