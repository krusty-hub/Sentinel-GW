import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createMockUpstreamServer } from '../mock_upstream/upstream.js';
import { ConfigManager } from '../../src/config/index.js';
import { MemoryLimiter } from '../../src/limiter/memory_limiter.js';
import { buildServer } from '../../src/server.js';
import { FastifyInstance } from 'fastify';

describe('Gateway End-to-End Pipeline Integration Tests', () => {
  let upstreamServer: http.Server;
  let app: FastifyInstance;
  let configManager: ConfigManager;
  let limiter: MemoryLimiter;

  beforeAll(async () => {
    // Start mock upstream on port 4567
    upstreamServer = await createMockUpstreamServer(4567);

    // Create custom test config in-memory via ConfigManager
    configManager = new ConfigManager('config/config.yaml');
    const cfg = configManager.getConfig();
    // Point upstream to local mock upstream
    for (const r of cfg.routes) {
      r.upstream_url = 'http://127.0.0.1:4567';
    }

    limiter = new MemoryLimiter({
      totalNodes: 1,
    });

    app = buildServer({
      configManager,
      limiter,
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await limiter.close();
    await new Promise<void>((resolve) => upstreamServer.close(() => resolve()));
  });

  it('GET /health returns OK with node and circuit info', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('OK');
    expect(body.circuit_breaker_state).toBe(0);
    expect(body.routes_count).toBeGreaterThan(0);
  });

  it('GET /metrics exposes Prometheus metrics format', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('sentinel_http_requests_total');
    expect(res.body).toContain('sentinel_circuit_breaker_state');
  });

  it('proxies allowed requests to upstream with RateLimit headers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/payments',
      headers: {
        'x-api-key': 'apikey_pro_8821',
        'content-type': 'application/json',
      },
      payload: { amount: 100, currency: 'USD' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('500');
    expect(res.headers['x-ratelimit-remaining']).toBe('499');
    expect(res.headers['x-ratelimit-policy']).toBeDefined();
    expect(res.headers['x-request-id']).toBeDefined();

    const body = JSON.parse(res.body);
    expect(body.status).toBe('success');
  });

  it('short-circuits with 429 when rate limit is exceeded', async () => {
    // Route auth_login has limit: 5 requests per 60 seconds (IP-based)
    const testIp = '198.51.100.77';

    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: {
          'x-forwarded-for': testIp,
        },
      });
      expect(res.statusCode).toBe(200);
    }

    // 6th request should return 429
    const blockedRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        'x-forwarded-for': testIp,
      },
    });

    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.headers['retry-after']).toBeDefined();
    expect(blockedRes.headers['x-ratelimit-remaining']).toBe('0');

    const blockedBody = JSON.parse(blockedRes.body);
    expect(blockedBody.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(blockedBody.error.policy).toBe('sliding_window_counter');
    expect(blockedBody.error.retry_after_seconds).toBeGreaterThan(0);
    expect(blockedBody.error.request_id).toBeDefined();
  });

  it('POST /admin/reload reloads configuration successfully', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/reload',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('OK');
    expect(body.message).toContain('reloaded successfully');
  });
});
