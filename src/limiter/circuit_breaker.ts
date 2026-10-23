import { CircuitState } from './types.js';
import { Clock, SystemClock } from './clock.js';

export interface CircuitBreakerOptions {
  failureThreshold?: number; // default: 5
  recoveryWindowMs?: number; // default: 10000 ms
  clock?: Clock;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures: number = 0;
  private openedAtMs: number = 0;
  private isProbing: boolean = false;

  private readonly failureThreshold: number;
  private readonly recoveryWindowMs: number;
  private readonly clock: Clock;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.recoveryWindowMs = options.recoveryWindowMs ?? 10000;
    this.clock = options.clock ?? new SystemClock();
    this.onStateChange = options.onStateChange;
  }

  public getState(): CircuitState {
    const nowMs = this.clock.now();
    if (this.state === CircuitState.OPEN) {
      if (nowMs - this.openedAtMs >= this.recoveryWindowMs) {
        this.transitionTo(CircuitState.HALF_OPEN);
      }
    }
    return this.state;
  }

  public shouldAllowExecution(): boolean {
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

  public recordSuccess(): void {
    const prevState = this.state;
    this.consecutiveFailures = 0;
    this.isProbing = false;

    if (prevState !== CircuitState.CLOSED) {
      this.transitionTo(CircuitState.CLOSED);
    }
  }

  public recordFailure(): void {
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

  private transitionTo(newState: CircuitState): void {
    if (this.state !== newState) {
      const from = this.state;
      this.state = newState;
      if (this.onStateChange) {
        this.onStateChange(from, newState);
      }
    }
  }

  public getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.openedAtMs = 0;
    this.isProbing = false;
  }
}
