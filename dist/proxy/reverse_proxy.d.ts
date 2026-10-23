import { FastifyReply, FastifyRequest } from 'fastify';
import { RouteConfig } from '../config/index.js';
import { RateLimitResult } from '../limiter/types.js';
import { TelemetryMetrics } from '../telemetry/metrics.js';
export declare class ReverseProxy {
    private agent;
    private metrics;
    constructor(metrics: TelemetryMetrics);
    forward(req: FastifyRequest, reply: FastifyReply, route: RouteConfig, rateLimitResult: RateLimitResult, timeoutMs: number): Promise<void>;
    close(): Promise<void>;
}
