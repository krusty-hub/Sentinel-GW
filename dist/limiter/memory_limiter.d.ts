import { Clock } from './clock.js';
import { IRateLimiter, RateLimitPolicy, RateLimitResult } from './types.js';
export declare class MemoryLimiter implements IRateLimiter {
    private readonly store;
    private readonly clock;
    private readonly totalNodes;
    private readonly maxEntries;
    private janitorTimer?;
    constructor(options?: {
        clock?: Clock;
        totalNodes?: number;
        maxEntries?: number;
        janitorIntervalMs?: number;
    });
    evaluate(routeId: string, clientId: string, policy: RateLimitPolicy, cost?: number): Promise<RateLimitResult>;
    private evaluateTokenBucket;
    private evaluateSlidingWindow;
    private evaluateLeakyBucket;
    private ensureCapacityLimit;
    sweepExpired(): void;
    getStoreSize(): number;
    clear(): void;
    close(): Promise<void>;
}
