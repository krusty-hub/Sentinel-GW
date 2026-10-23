import { Agent, request as undiciRequest } from 'undici';
export class ReverseProxy {
    agent;
    metrics;
    constructor(metrics) {
        this.metrics = metrics;
        this.agent = new Agent({
            keepAliveTimeout: 30000,
            keepAliveMaxTimeout: 60000,
            connections: 200,
            pipelining: 1,
        });
    }
    async forward(req, reply, route, rateLimitResult, timeoutMs) {
        // Inject rate limit headers onto response context
        reply.header('X-RateLimit-Limit', rateLimitResult.limit.toString());
        reply.header('X-RateLimit-Remaining', rateLimitResult.remaining.toString());
        reply.header('X-RateLimit-Reset', rateLimitResult.resetEpochSec.toString());
        reply.header('X-RateLimit-Policy', rateLimitResult.policyDescription);
        const targetUrl = new URL(req.url, route.upstream_url);
        const method = req.method;
        // Filter headers to forward
        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
            if (value !== undefined && key !== 'host' && key !== 'connection') {
                headers[key] = Array.isArray(value) ? value.join(', ') : value;
            }
        }
        // Inject proxy headers
        headers['x-forwarded-host'] = req.hostname;
        headers['x-gateway-route'] = route.id;
        const startTime = performance.now();
        try {
            let body = undefined;
            if (req.body) {
                body = typeof req.body === 'string' || Buffer.isBuffer(req.body)
                    ? req.body
                    : JSON.stringify(req.body);
            }
            const response = await undiciRequest(targetUrl.toString(), {
                dispatcher: this.agent,
                method,
                headers,
                body,
                headersTimeout: timeoutMs,
                bodyTimeout: timeoutMs,
            });
            const elapsedSec = (performance.now() - startTime) / 1000;
            this.metrics.upstreamDurationSeconds.labels(route.id).observe(elapsedSec);
            reply.status(response.statusCode);
            // Copy response headers
            for (const [key, value] of Object.entries(response.headers)) {
                if (value !== undefined && key !== 'connection' && key !== 'transfer-encoding') {
                    reply.header(key, value);
                }
            }
            const responseBody = await response.body.text();
            reply.send(responseBody);
        }
        catch (err) {
            const elapsedSec = (performance.now() - startTime) / 1000;
            this.metrics.upstreamDurationSeconds.labels(route.id).observe(elapsedSec);
            const isTimeout = err instanceof Error &&
                (err.message.includes('timeout') || err.message.includes('HeadersTimeoutError'));
            const status = isTimeout ? 504 : 502;
            const message = isTimeout
                ? `Upstream timed out after ${timeoutMs}ms`
                : 'Bad Gateway: Upstream connection failed';
            reply.status(status).send({
                error: {
                    code: isTimeout ? 'GATEWAY_TIMEOUT' : 'BAD_GATEWAY',
                    message,
                    route_id: route.id,
                },
            });
        }
    }
    async close() {
        await this.agent.close();
    }
}
//# sourceMappingURL=reverse_proxy.js.map