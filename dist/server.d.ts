import { FastifyInstance } from 'fastify';
import { ConfigManager } from './config/index.js';
import { IRateLimiter } from './limiter/types.js';
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
export declare function buildServer(options: CreateServerOptions): FastifyInstance;
