import { CircuitState } from './types.js';
import { SystemClock } from './clock.js';
export class CircuitBreaker {
    state = CircuitState.CLOSED;
    consecutiveFailures = 0;
    openedAtMs = 0;
    isProbing = false;
    failureThreshold;
    recoveryWindowMs;
    clock;
    onStateChange;
    constructor(options = {}) {
        this.failureThreshold = options.failureThreshold ?? 5;
        this.recoveryWindowMs = options.recoveryWindowMs ?? 10000;
        this.clock = options.clock ?? new SystemClock();
        this.onStateChange = options.onStateChange;
    }
    getState() {
        const nowMs = this.clock.now();
        if (this.state === CircuitState.OPEN) {
            if (nowMs - this.openedAtMs >= this.recoveryWindowMs) {
                this.transitionTo(CircuitState.HALF_OPEN);
            }
        }
        return this.state;
    }
    shouldAllowExecution() {
        const currentState = this.getState();
        if (currentState === CircuitState.CLOSED) {
            return true;
        }
        if (currentState === CircuitState.HALF_OPEN) {
            if (!this.isProbing) {
                this.isProbing = true;
                return true; // Allow single probe request
            }
            return false; // Other concurrent requests use fallback while probe runs
        }
        return false; // OPEN -> fallback
    }
    recordSuccess() {
        const prevState = this.state;
        this.consecutiveFailures = 0;
        this.isProbing = false;
        if (prevState !== CircuitState.CLOSED) {
            this.transitionTo(CircuitState.CLOSED);
        }
    }
    recordFailure() {
        const prevState = this.state;
        this.isProbing = false;
        if (prevState === CircuitState.HALF_OPEN) {
            // Probe failed, go back to OPEN immediately
            this.openedAtMs = this.clock.now();
            this.transitionTo(CircuitState.OPEN);
            return;
        }
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.failureThreshold) {
            this.openedAtMs = this.clock.now();
            this.transitionTo(CircuitState.OPEN);
        }
    }
    transitionTo(newState) {
        if (this.state !== newState) {
            const from = this.state;
            this.state = newState;
            if (this.onStateChange) {
                this.onStateChange(from, newState);
            }
        }
    }
    getConsecutiveFailures() {
        return this.consecutiveFailures;
    }
    reset() {
        this.state = CircuitState.CLOSED;
        this.consecutiveFailures = 0;
        this.openedAtMs = 0;
        this.isProbing = false;
    }
}
//# sourceMappingURL=circuit_breaker.js.map