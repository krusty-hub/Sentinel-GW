export type AlgorithmType = 'token_bucket' | 'sliding_window_counter' | 'leaky_bucket';
export interface TokenBucketPolicy {
    algorithm: 'token_bucket';
    capacity: number;
    refill_rate_per_sec: number;
    cost?: number;
}
export interface SlidingWindowPolicy {
    algorithm: 'sliding_window_counter';
    limit: number;
    window_seconds: number;
}
export interface LeakyBucketPolicy {
    algorithm: 'leaky_bucket';
    capacity: number;
    leak_rate_per_sec: number;
    cost?: number;
}
export type RateLimitPolicy = TokenBucketPolicy | SlidingWindowPolicy | LeakyBucketPolicy;
export interface RateLimitResult {
    allowed: boolean;
    limit: number;
    remaining: number;
    retryAfterMs: number;
    resetEpochSec: number;
    backend: 'redis' | 'local_l1';
    policyDescription: string;
}
export interface IRateLimiter {
    evaluate(routeId: string, clientId: string, policy: RateLimitPolicy, cost?: number): Promise<RateLimitResult>;
    close?(): Promise<void>;
}
export declare enum CircuitState {
    CLOSED = 0,
    HALF_OPEN = 1,
    OPEN = 2
}
