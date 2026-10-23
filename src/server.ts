import crypto from 'node:crypto';
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ConfigManager, RouteConfig } from './config/index.js';
import { extractIdentityAndPolicy } from './middleware/identity.js';
import { IRateLimiter, RateLimitResult } from './limiter/types.js';
import { ReverseProxy } from './proxy/reverse_proxy.js';
import { TelemetryMetrics } from './telemetry/metrics.js';
import { StructuredLogger } from './telemetry/logger.js';
import { CircuitBreaker } from './limiter/circuit_breaker.js';

export interface CreateServerOptions {
  configManager: ConfigManager;
  limiter: IRateLimiter;
  circuitBreaker?: CircuitBreaker;
  metrics?: TelemetryMetrics;
  logger?: StructuredLogger;
}

export function buildServer(options: CreateServerOptions): FastifyInstance {
  const { configManager, limiter } = options;
  let currentConfig = configManager.getConfig();

  const metrics = options.metrics ?? new TelemetryMetrics();
  const logger = options.logger ?? new StructuredLogger(currentConfig.server.node_id);
  const reverseProxy = new ReverseProxy(metrics);

  if (options.circuitBreaker) {
    // Sync initial state and listen to state changes
    metrics.circuitBreakerState.set(options.circuitBreaker.getState());
  }

  // Update config when reloaded
  configManager.onReload((newConfig) => {
    currentConfig = newConfig;
    logger.setNodeId(newConfig.server.node_id);
    logger.info('Gateway configuration reloaded successfully', {
      node_id: newConfig.server.node_id,
      routes_count: newConfig.routes.length,
    });
  });

  const app = Fastify({
    logger: false, // We use custom StructuredLogger according to PRD
  });

  // Transparent gateway body forwarding: pass raw bytes directly to upstream without breaking
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  // Prometheus scrape endpoint
  app.get('/metrics', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (options.circuitBreaker) {
      metrics.circuitBreakerState.set(options.circuitBreaker.getState());
    }
    const data = await metrics.getMetrics();
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(data);
  });

  // Health endpoint
  app.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    const cbState = options.circuitBreaker ? options.circuitBreaker.getState() : 0;
    return reply.send({
      status: 'OK',
      node_id: currentConfig.server.node_id,
      circuit_breaker_state: cbState, // 0 = Closed, 1 = Half-Open, 2 = Open
      routes_count: currentConfig.routes.length,
    });
  });

  // Admin config hot reload endpoint
  app.post('/admin/reload', async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const reloaded = configManager.reload();
      return reply.send({
        status: 'OK',
        message: 'Configuration reloaded successfully',
        node_id: reloaded.server.node_id,
        routes: reloaded.routes.map((r) => r.id),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({
        status: 'ERROR',
        message: `Failed to reload configuration: ${msg}`,
      });
    }
  });

  // Catch-all route handler for API proxying & rate limiting
  app.all('/*', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsedPath = req.url.split('?')[0];
    let matchedRoute: RouteConfig | undefined;

    if (parsedPath === '/proxy') {
      const targetQueryUrl = (req.query as Record<string, string>)?.url;
      if (!targetQueryUrl) {
        return reply.status(400).send({
          error: {
            code: 'MISSING_URL',
            message: 'Please provide a URL parameter, e.g. http://127.0.0.1:8080/proxy?url=https://jsonplaceholder.typicode.com/todos/1',
          },
        });
      }
      try {
        new URL(targetQueryUrl);
      } catch {
        return reply.status(400).send({
          error: {
            code: 'INVALID_URL',
            message: `The provided URL "${targetQueryUrl}" is not valid. Please include http:// or https://`,
          },
        });
      }

      matchedRoute = {
        id: 'dynamic_proxy',
        path_prefix: '/proxy',
        methods: ['*'],
        upstream_url: targetQueryUrl,
        identity_source: 'ip',
        override_policy: {
          algorithm: 'token_bucket',
          capacity: 5,
          refill_rate_per_sec: 1.0,
        },
      };
    } else {
      matchedRoute = findMatchingRoute(req.url, req.method, currentConfig.routes);
    }

    if (!matchedRoute) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: `No matching route for ${req.method} ${req.url}`,
        },
      });
    }

    const requestId =
      (req.headers['x-request-id'] as string) ||
      `req_${crypto.randomBytes(6).toString('hex')}`;

    const identity = extractIdentityAndPolicy(req, matchedRoute, currentConfig);
    const rlStartTime = performance.now();

    let rlResult: RateLimitResult;
    try {
      rlResult = await limiter.evaluate(matchedRoute.id, identity.clientId, identity.policy, 1);
    } catch (err) {
      logger.error('Unexpected error during rate limit evaluation', err);
      // Fail-open principle: if limiter crashes unexpectedly, allow request
      rlResult = {
        allowed: true,
        limit: 100,
        remaining: 99,
        retryAfterMs: 0,
        resetEpochSec: Math.ceil(Date.now() / 1000) + 60,
        backend: 'local_l1',
        policyDescription: 'fail_open',
      };
    }

    const rlDurationMs = performance.now() - rlStartTime;

    // Attach RateLimit headers
    reply.header('X-RateLimit-Limit', rlResult.limit.toString());
    reply.header('X-RateLimit-Remaining', rlResult.remaining.toString());
    reply.header('X-RateLimit-Reset', rlResult.resetEpochSec.toString());
    reply.header('X-RateLimit-Policy', rlResult.policyDescription);
    reply.header('X-Request-Id', requestId);

    if (!rlResult.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(rlResult.retryAfterMs / 1000));
      reply.header('Retry-After', retryAfterSeconds.toString());

      // Structured WARN log
      logger.logThrottled({
        requestId,
        clientId: identity.clientId,
        routeId: matchedRoute.id,
        algorithm: identity.policy.algorithm,
        remaining: rlResult.remaining,
        retryAfterMs: rlResult.retryAfterMs,
        rlEvalLatencyMs: rlDurationMs,
      });

      // Prometheus metric
      metrics.httpRequestsTotal
        .labels(matchedRoute.id, req.method, '429', 'throttled')
        .inc();

      return reply.status(429).send({
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Please retry after ${retryAfterSeconds} seconds.`,
          policy: identity.policy.algorithm,
          limit: rlResult.limit,
          remaining: rlResult.remaining,
          retry_after_seconds: retryAfterSeconds,
          reset_at_epoch: rlResult.resetEpochSec,
          request_id: requestId,
        },
      });
    }

    // Allowed: forward to upstream
    const decision = rlResult.backend === 'local_l1' ? 'fallback_allowed' : 'allowed';

    try {
      await reverseProxy.forward(
        req,
        reply,
        matchedRoute,
        rlResult,
        currentConfig.server.upstream_timeout_ms
      );

      metrics.httpRequestsTotal
        .labels(matchedRoute.id, req.method, reply.statusCode.toString(), decision)
        .inc();
    } catch (proxyErr) {
      metrics.httpRequestsTotal
        .labels(matchedRoute.id, req.method, '502', decision)
        .inc();
    }
  });

  return app;
}

function findMatchingRoute(
  url: string,
  method: string,
  routes: RouteConfig[]
): RouteConfig | undefined {
  const parsedPath = url.split('?')[0];
  for (const route of routes) {
    if (parsedPath.startsWith(route.path_prefix)) {
      if (route.methods.includes(method) || route.methods.includes('*')) {
        return route;
      }
    }
  }
  return undefined;
}
