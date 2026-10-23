import crypto from 'node:crypto';
import Fastify from 'fastify';
import { extractIdentityAndPolicy } from './middleware/identity.js';
import { ReverseProxy } from './proxy/reverse_proxy.js';
import { TelemetryMetrics } from './telemetry/metrics.js';
import { StructuredLogger } from './telemetry/logger.js';
export function buildServer(options) {
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
    // Prometheus scrape endpoint
    app.get('/metrics', async (_req, reply) => {
        if (options.circuitBreaker) {
            metrics.circuitBreakerState.set(options.circuitBreaker.getState());
        }
        const data = await metrics.getMetrics();
        reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        return reply.send(data);
    });
    // Health endpoint
    app.get('/health', async (_req, reply) => {
        const cbState = options.circuitBreaker ? options.circuitBreaker.getState() : 0;
        return reply.send({
            status: 'OK',
            node_id: currentConfig.server.node_id,
            circuit_breaker_state: cbState, // 0 = Closed, 1 = Half-Open, 2 = Open
            routes_count: currentConfig.routes.length,
        });
    });
    // Admin config hot reload endpoint
    app.post('/admin/reload', async (_req, reply) => {
        try {
            const reloaded = configManager.reload();
            return reply.send({
                status: 'OK',
                message: 'Configuration reloaded successfully',
                node_id: reloaded.server.node_id,
                routes: reloaded.routes.map((r) => r.id),
            });
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return reply.status(500).send({
                status: 'ERROR',
                message: `Failed to reload configuration: ${msg}`,
            });
        }
    });
    // Catch-all route handler for API proxying & rate limiting
    app.all('/*', async (req, reply) => {
        const matchedRoute = findMatchingRoute(req.url, req.method, currentConfig.routes);
        if (!matchedRoute) {
            return reply.status(404).send({
                error: {
                    code: 'NOT_FOUND',
                    message: `No matching route for ${req.method} ${req.url}`,
                },
            });
        }
        const requestId = req.headers['x-request-id'] ||
            `req_${crypto.randomBytes(6).toString('hex')}`;
        const identity = extractIdentityAndPolicy(req, matchedRoute, currentConfig);
        const rlStartTime = performance.now();
        let rlResult;
        try {
            rlResult = await limiter.evaluate(matchedRoute.id, identity.clientId, identity.policy, 1);
        }
        catch (err) {
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
            await reverseProxy.forward(req, reply, matchedRoute, rlResult, currentConfig.server.upstream_timeout_ms);
            metrics.httpRequestsTotal
                .labels(matchedRoute.id, req.method, reply.statusCode.toString(), decision)
                .inc();
        }
        catch (proxyErr) {
            metrics.httpRequestsTotal
                .labels(matchedRoute.id, req.method, '502', decision)
                .inc();
        }
    });
    return app;
}
function findMatchingRoute(url, method, routes) {
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
//# sourceMappingURL=server.js.map