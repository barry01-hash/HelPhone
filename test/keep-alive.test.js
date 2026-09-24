import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import express from 'express';
import {
  KEEP_ALIVE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
  resolveKeepAliveOptions,
  applyKeepAliveTuning,
  keepAliveMiddleware,
} from '../server/middleware/keepAlive.js';

describe('keep-alive defaults', () => {
  it('uses 65s keep-alive and 66s headers timeouts', () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(HEADERS_TIMEOUT_MS).toBe(66_000);
    expect(resolveKeepAliveOptions({}, {})).toEqual({
      keepAliveTimeout: 65_000,
      headersTimeout: 66_000,
      maxRequestsPerSocket: 0,
    });
  });

  it('keeps keepAliveTimeout above the 60s balancer idle timeout', () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});

describe('resolveKeepAliveOptions', () => {
  it('reads env overrides', () => {
    const r = resolveKeepAliveOptions({}, {
      KEEP_ALIVE_TIMEOUT_MS: '70000',
      HEADERS_TIMEOUT_MS: '72000',
      MAX_REQUESTS_PER_SOCKET: '500',
    });
    expect(r).toEqual({ keepAliveTimeout: 70_000, headersTimeout: 72_000, maxRequestsPerSocket: 500 });
  });

  it('prefers explicit options over env', () => {
    const r = resolveKeepAliveOptions({ keepAliveTimeout: 10_000, headersTimeout: 20_000 }, { KEEP_ALIVE_TIMEOUT_MS: '99999' });
    expect(r.keepAliveTimeout).toBe(10_000);
    expect(r.headersTimeout).toBe(20_000);
  });

  it.each(['abc', '-5', '0', '1.5', ''])('ignores invalid env value %j', (bad) => {
    const r = resolveKeepAliveOptions({}, { KEEP_ALIVE_TIMEOUT_MS: bad, HEADERS_TIMEOUT_MS: bad });
    expect(r.keepAliveTimeout).toBe(65_000);
    expect(r.headersTimeout).toBe(66_000);
  });

  it('ignores an invalid MAX_REQUESTS_PER_SOCKET', () => {
    expect(resolveKeepAliveOptions({}, { MAX_REQUESTS_PER_SOCKET: '-1' }).maxRequestsPerSocket).toBe(0);
    expect(resolveKeepAliveOptions({}, { MAX_REQUESTS_PER_SOCKET: 'x' }).maxRequestsPerSocket).toBe(0);
    expect(resolveKeepAliveOptions({}, {}).maxRequestsPerSocket).toBe(0);
  });

  it('raises headersTimeout to stay above keepAliveTimeout', () => {
    const r = resolveKeepAliveOptions({ keepAliveTimeout: 80_000, headersTimeout: 66_000 }, {});
    expect(r.headersTimeout).toBe(81_000);
    const eq = resolveKeepAliveOptions({ keepAliveTimeout: 5_000, headersTimeout: 5_000 }, {});
    expect(eq.headersTimeout).toBe(6_000);
  });
});

describe('applyKeepAliveTuning', () => {
  it('sets the timeouts on the server', () => {
    const server = http.createServer();
    const applied = applyKeepAliveTuning(server);
    expect(server.keepAliveTimeout).toBe(applied.keepAliveTimeout);
    expect(server.headersTimeout).toBe(applied.headersTimeout);
    expect(server.keepAliveTimeout).toBe(65_000);
    expect(server.headersTimeout).toBe(66_000);
    expect(server.maxRequestsPerSocket).toBe(0);
    server.close();
  });
});

describe('keepAliveMiddleware', () => {
  const run = (httpVersionMajor, options) => {
    const headers = {};
    let called = false;
    keepAliveMiddleware(options)(
      { httpVersionMajor },
      { setHeader: (k, v) => { headers[k] = v; } },
      () => { called = true; },
    );
    return { headers, called };
  };

  it('advertises the keep-alive window on HTTP/1.1', () => {
    const { headers, called } = run(1);
    expect(headers).toEqual({ Connection: 'keep-alive', 'Keep-Alive': 'timeout=65' });
    expect(called).toBe(true);
  });

  it('reflects a custom timeout', () => {
    expect(run(1, { keepAliveTimeout: 30_000 }).headers['Keep-Alive']).toBe('timeout=30');
  });

  it('emits no connection-specific headers on HTTP/2', () => {
    const { headers, called } = run(2);
    expect(headers).toEqual({});
    expect(called).toBe(true);
  });
});

describe('socket reuse over a real server', () => {
  let server;
  afterEach(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  it('serves sequential requests over one TCP connection', async () => {
    const app = express();
    app.use(keepAliveMiddleware());
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    applyKeepAliveTuning(server);
    let connections = 0;
    server.on('connection', () => { connections++; });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const get = () => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/ping', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      }).on('error', reject);
    });

    const first = await get();
    await get();
    await get();
    agent.destroy();

    expect(connections).toBe(1);
    expect(first.connection).toBe('keep-alive');
    expect(first['keep-alive']).toBe('timeout=65');
  });
});
