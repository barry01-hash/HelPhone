# Performance Optimization

## HTTP Keep-Alive socket pool (`server/middleware/keepAlive.ts`)

Node's default `keepAliveTimeout` is 5 seconds. The load balancers in front of the prover (Render, Cloudflare) hold idle connections for about 60 seconds, so they routinely reuse a socket that the origin already closed. The client sees that as an intermittent `502`. Keeping origin sockets open longer than the balancer does removes the race, and it lets sequential REST calls and WebSocket upgrades reuse one TCP connection instead of paying a new handshake each time.

| Setting | Value | Why |
| --- | --- | --- |
| `keepAliveTimeout` | 65,000 ms | Must exceed the balancer's ~60 s idle timeout |
| `headersTimeout` | 66,000 ms | Must exceed `keepAliveTimeout`, or Node can reset a reused socket while it waits for the next request line |
| `maxRequestsPerSocket` | 0 (unlimited) | Optional cap; set to recycle long-lived sockets |

`applyKeepAliveTuning(server)` applies these to the `http.Server` in `server/index.js` (the Render runtime) and `server/index.ts`. `keepAliveMiddleware()` advertises `Connection: keep-alive` and `Keep-Alive: timeout=65` on HTTP/1.x responses. It emits nothing on HTTP/2, where connection-specific headers are forbidden.

### Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `KEEP_ALIVE_TIMEOUT_MS` | `65000` | Positive integer; invalid values fall back to the default |
| `HEADERS_TIMEOUT_MS` | `66000` | Automatically raised to `keepAliveTimeout + 1000` if set at or below it |
| `MAX_REQUESTS_PER_SOCKET` | `0` | Non-negative integer; `0` means unlimited |

Both timeouts are also set in `render.yaml`.

### HTTP/2

Express does not serve HTTP/2 directly. HTTP/2 is negotiated by the TLS-terminating edge, and it multiplexes requests over one connection there. The tuning above applies to the HTTP/1.1 hop from the edge to this origin, which is where socket reuse matters. Nothing in the middleware assumes HTTP/1.1 only.

### Verification

`test/keep-alive.test.js` starts a real server, sends three sequential requests through a keep-alive agent, and asserts that exactly one TCP connection was opened. It runs in CI with the other subsystem tests. The ~90% handshake-overhead reduction in the original issue is what this reuse yields for sequential calls (one handshake per session instead of one per request). It is not measured by the suite.

## OffscreenCanvas map overlay (`src/lib/offscreenCanvas.ts`, `src/workers/canvas-worker.js`)

Animated markers on the community map (pulsing rings for pending, en-route, resolved and responder states) are drawn on a `<canvas>` layered over the SVG map. Where the browser supports it, control of that canvas is handed to a Web Worker with `canvas.transferControlToOffscreen()`, so the animation runs on its own thread and is not starved by React renders or map interaction.

```
CommunityMap.jsx ── createOverlayRenderer(canvas) ─┬─ worker mode:      transferControlToOffscreen() ─> canvas-worker.js (rAF loop)
                                                   └─ main-thread mode: requestAnimationFrame loop, same drawOverlayFrame()
```

Both modes call the same `drawOverlayFrame()`, so the output is identical. Main-thread mode is used when `Worker`, `OffscreenCanvas` or `transferControlToOffscreen` is missing. If the worker fails after control was transferred, the canvas cannot be reused, so `CommunityMap` remounts a fresh canvas and forces main-thread mode.

Usage: pass `overlays` (an array of `{ id, x, y, kind }` in map viewBox units, `1140 x 540`) and optionally `onRenderStats`. With no `overlays` prop, no canvas is rendered and behaviour is unchanged.

### Frame rate

The loop is driven by `requestAnimationFrame`, so it runs at the display refresh rate (60 Hz on most screens). The rate is measured, not assumed: `FpsMeter` reports `{ fps, frames, windowMs }` once per second through `onRenderStats`. A device that cannot hold 60 FPS shows a lower number instead of a false claim. The unit tests verify the scheduling, the drawing and the message protocol with a fake clock. They do not measure real frame rates, which need a browser and a profile of the actual overlay count.
