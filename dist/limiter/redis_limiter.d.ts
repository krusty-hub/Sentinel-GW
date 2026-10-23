import { Redis } from 'ioredis';
import { CircuitBreaker } from './circuit_breaker.js';
import { MemoryLimiter } from './memory_limiter.js';
import { IRateLimiter, RateLimitPolicy, RateLimitResult, CircuitState } from './types.js';
export interface RedisLimiterOptions {
    redisClient?: Redis;
    redisAddress?: string;
    commandTimeoutMs?: number;
    circuitBreaker?: CircuitBreaker;
    fallbackLimiter: MemoryLimiter;
    scriptsDir?: string;
    onRedisLatency?: (latencySeconds: number, backend: 'redis' | 'local_l1') => void;
}
export declare class RedisLimiter implements IRateLimiter {
    private redis;
    private isExternalRedis;
    private readonly commandTimeoutMs;
    private readonly circuitBreaker;
    private readonly fallbackLimiter;
    private readonly onRedisLatency?;
    private scripts;
    private isScriptsLoaded;
    constructor(options: RedisLimiterOptions);
    private loadScriptFiles;
    preloadScripts(): Promise<void>;
    evaluate(routeId: string, clientId: string, policy: RateLimitPolicy, cost?: number): Promise<RateLimitResult>;
    private executeRedisLimiter;
    private executeWithTimeout;
    getCircuitBreaker(): CircuitBreaker;
    getCircuitState(): CircuitState;
    getFallbackLimiter(): MemoryLimiter;
    close(): Promise<void>;
}
