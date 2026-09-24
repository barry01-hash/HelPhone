// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';

const renderer = { mode: 'worker', setOverlays: vi.fn(), resize: vi.fn(), destroy: vi.fn() };
const createOverlayRenderer = vi.fn(() => renderer);

vi.mock('../src/lib/offscreenCanvas.ts', () => ({ createOverlayRenderer: (...a) => createOverlayRenderer(...a) }));

import CommunityMap from '../src/components/CommunityMap.jsx';

const overlays = [{ id: 'a', x: 10, y: 20, kind: 'pending' }];

describe('CommunityMap canvas overlay', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders only the SVG when no overlays prop is given', () => {
    const { container } = render(<CommunityMap />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('map-overlay-canvas')).toBeNull();
    expect(createOverlayRenderer).not.toHaveBeenCalled();
  });

  it('layers a non-interactive, aria-hidden canvas over the map when overlays are provided', () => {
    render(<CommunityMap overlays={overlays} />);
    const canvas = screen.getByTestId('map-overlay-canvas');
    expect(canvas.getAttribute('aria-hidden')).toBe('true');
    expect(canvas.style.pointerEvents).toBe('none');
    expect(createOverlayRenderer).toHaveBeenCalledTimes(1);
    expect(createOverlayRenderer.mock.calls[0][0]).toBe(canvas);
    expect(createOverlayRenderer.mock.calls[0][1]).toMatchObject({ width: 1140, height: 540, forceMainThread: false });
  });

  it('pushes overlay updates to the renderer without recreating it', () => {
    const { rerender } = render(<CommunityMap overlays={overlays} />);
    expect(renderer.setOverlays).toHaveBeenLastCalledWith(overlays);
    const next = [...overlays, { id: 'b', x: 1, y: 2, kind: 'resolved' }];
    rerender(<CommunityMap overlays={next} />);
    expect(renderer.setOverlays).toHaveBeenLastCalledWith(next);
    expect(createOverlayRenderer).toHaveBeenCalledTimes(1);
  });

  it('forwards measured frame stats to onRenderStats', () => {
    const onRenderStats = vi.fn();
    render(<CommunityMap overlays={overlays} onRenderStats={onRenderStats} />);
    const stats = { fps: 60, frames: 60, windowMs: 1000 };
    createOverlayRenderer.mock.calls[0][1].onStats(stats);
    expect(onRenderStats).toHaveBeenCalledWith(stats);
  });

  it('tolerates stats arriving with no onRenderStats handler', () => {
    render(<CommunityMap overlays={overlays} />);
    expect(() => createOverlayRenderer.mock.calls[0][1].onStats({ fps: 1 })).not.toThrow();
  });

  it('remounts a fresh canvas in main-thread mode when the worker fails', () => {
    render(<CommunityMap overlays={overlays} />);
    const firstCanvas = screen.getByTestId('map-overlay-canvas');
    act(() => createOverlayRenderer.mock.calls[0][1].onError(new Error('worker died')));
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    expect(createOverlayRenderer).toHaveBeenCalledTimes(2);
    expect(createOverlayRenderer.mock.calls[1][1].forceMainThread).toBe(true);
    expect(screen.getByTestId('map-overlay-canvas')).not.toBe(firstCanvas);
  });

  it('destroys the renderer on unmount', () => {
    const { unmount } = render(<CommunityMap overlays={overlays} />);
    unmount();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('caps the device pixel ratio at 2', () => {
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    render(<CommunityMap overlays={overlays} />);
    expect(createOverlayRenderer.mock.calls[0][1].dpr).toBe(2);
  });
});
