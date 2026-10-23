import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../../src/limiter/circuit_breaker.js';
import { CircuitState } from '../../src/limiter/types.js';
import { MockClock } from '../../src/limiter/clock.js';

describe('Circuit Breaker State Machine Tests', () => {
  let clock: MockClock;
  let breaker: CircuitBreaker;
  const transitions: { from: CircuitState; to: CircuitState }[] = [];

  beforeEach(() => {
    clock = new MockClock(1000);
    transitions.length = 0;
    breaker = new CircuitBreaker({
      failureThreshold: 5,
      recoveryWindowMs: 10000,
      clock,
      onStateChange: (from, to) => {
        transitions.push({ from, to });
      },
    });
  });

  it('starts in CLOSED state and allows execution', () => {
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.shouldAllowExecution()).toBe(true);
  });

  it('transitions to OPEN after 5 consecutive failures', () => {
    for (let i = 0; i < 4; i++) {
      breaker.recordFailure();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.shouldAllowExecution()).toBe(true);
    }

    // 5th failure trips the breaker
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.shouldAllowExecution()).toBe(false);
    expect(transitions).toEqual([{ from: CircuitState.CLOSED, to: CircuitState.OPEN }]);
  });

  it('transitions from OPEN to HALF_OPEN after recoveryWindowMs passes', () => {
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // 5 seconds later - still OPEN
    clock.advance(5000);
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.shouldAllowExecution()).toBe(false);

    // Advance past 10,000ms recovery window
    clock.advance(5001);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // In HALF_OPEN, exactly one probe request is allowed
    expect(breaker.shouldAllowExecution()).toBe(true);
    // Subsequent requests while probe is in flight are routed to fallback
    expect(breaker.shouldAllowExecution()).toBe(false);
  });

  it('transitions from HALF_OPEN to CLOSED if probe succeeds', () => {
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }
    clock.advance(10001);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Probe allowed
    breaker.shouldAllowExecution();

    // Probe succeeds
    breaker.recordSuccess();
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getConsecutiveFailures()).toBe(0);
    expect(breaker.shouldAllowExecution()).toBe(true);
  });

  it('transitions from HALF_OPEN back to OPEN if probe fails', () => {
    for (let i = 0; i < 5; i++) {
      breaker.recordFailure();
    }
    clock.advance(10001);
    expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

    // Probe allowed
    breaker.shouldAllowExecution();

    // Probe fails
    breaker.recordFailure();
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(breaker.shouldAllowExecution()).toBe(false);
  });
});
