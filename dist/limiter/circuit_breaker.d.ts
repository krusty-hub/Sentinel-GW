import { CircuitState } from './types.js';
import { Clock } from './clock.js';
export interface CircuitBreakerOptions {
    failureThreshold?: number;
    recoveryWindowMs?: number;
    clock?: Clock;
    onStateChange?: (from: CircuitState, to: CircuitState) => void;
}
export declare class CircuitBreaker {
    private state;
    private consecutiveFailures;
    private openedAtMs;
    private isProbing;
    private readonly failureThreshold;
    private readonly recoveryWindowMs;
    private readonly clock;
    private readonly onStateChange?;
    constructor(options?: CircuitBreakerOptions);
    getState(): CircuitState;
    shouldAllowExecution(): boolean;
    recordSuccess(): void;
    recordFailure(): void;
    private transitionTo;
    getConsecutiveFailures(): number;
    reset(): void;
}
