import { describe, it, expect, beforeEach } from 'vitest';
import { MockClock } from '../../src/limiter/clock.js';
import { MemoryLimiter } from '../../src/limiter/memory_limiter.js';
import { TokenBucketPolicy, SlidingWindowPolicy, LeakyBucketPolicy } from '../../src/limiter/types.js';

describe('Deterministic Unit Tests (Mock Clock) - PRD Test Suite 1', () => {
  let mockClock: MockClock;
  let limiter: MemoryLimiter;

  beforeEach(() => {
    mockClock = new MockClock(0);
    limiter = new MemoryLimiter({
      clock: mockClock,
      totalNodes: 1, // Single node for exact capacity testing
      janitorIntervalMs: 0,
    });
  });

  describe('Token Bucket: Burst Depletion & Lazy Refill (PRD 7.1.1 & 7.1.2)', () => {
    const policy: TokenBucketPolicy = {
      algorithm: 'token_bucket',
      capacity: 5,
      refill_rate_per_sec: 1.0,
    };

    it('should allow 5 requests at t=0ms and deplete tokens 4 -> 0', async () => {
      // 5 requests at t = 0
      for (let i = 0; i < 5; i++) {
        const res = await limiter.evaluate('route_test', 'client_1', policy);
        expect(res.allowed).toBe(true);
        expect(res.remaining).toBe(4 - i);
        expect(res.retryAfterMs).toBe(0);
      }

      // Fire 6th request at t = 100ms
      mockClock.advance(100);
      const res6 = await limiter.evaluate('route_test', 'client_1', policy);
      expect(res6.allowed).toBe(false);
      expect(res6.remaining).toBe(0);
      // At t=100ms, elapsed=0.1s -> tokens refilled = 0.1
      // Needed: 1 - 0.1 = 0.9 tokens -> retry_after = ceil(0.9 / 1.0 * 1000) = 900ms
      expect(res6.retryAfterMs).toBe(900);
    });

    it('should lazily refill partial tokens at t=2500ms and allow request (PRD 7.1.2)', async () => {
      // First deplete all 5 tokens
      for (let i = 0; i < 5; i++) {
        await limiter.evaluate('route_test', 'client_2', policy);
      }

      // Advance clock to t = 2500ms
      mockClock.advance(2500);

      // Lazy refill calculates min(5, 0 + 2.5 * 1) = 2.5 tokens
      // Consumes 1 -> remaining tokens = 1.5 -> floor(1.5) = 1
      const res = await limiter.evaluate('route_test', 'client_2', policy);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(1);
      expect(res.retryAfterMs).toBe(0);
    });
  });

  describe('Sliding Window Boundary Test (PRD 7.1.3)', () => {
    const policy: SlidingWindowPolicy = {
      algorithm: 'sliding_window_counter',
      limit: 10,
      window_seconds: 60,
    };

    it('prevents 2x boundary exploit at window boundaries', async () => {
      // Window 0 is [0s, 60s). Fire 10 requests at t = 59s (59000ms)
      mockClock.set(59000);
      for (let i = 0; i < 10; i++) {
        const res = await limiter.evaluate('route_login', 'attacker_ip', policy);
        expect(res.allowed).toBe(true);
      }

      // 11th request at t = 59s must be blocked
      const blockedAt59 = await limiter.evaluate('route_login', 'attacker_ip', policy);
      expect(blockedAt59.allowed).toBe(false);

      // Advance clock to t = 61s (61000ms) -> 1 second into Window 1
      mockClock.set(61000);

      // Weight from prev window = (60 - 1) / 60 = 59/60
      // Estimated prev = floor(10 * 59/60) = floor(9.833) = 9
      // Current count = 0
      // Total estimated = 9 < limit (10) -> exactly 1 request allowed!
      const res61_1 = await limiter.evaluate('route_login', 'attacker_ip', policy);
      expect(res61_1.allowed).toBe(true);
      expect(res61_1.remaining).toBe(0); // Estimated count now = 10, remaining = 0

      // A 2nd request at t = 61s must be blocked (estimated count would be 11)
      const res61_2 = await limiter.evaluate('route_login', 'attacker_ip', policy);
      expect(res61_2.allowed).toBe(false);
      expect(res61_2.retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('Leaky Bucket (Metered Queue)', () => {
    const policy: LeakyBucketPolicy = {
      algorithm: 'leaky_bucket',
      capacity: 5,
      leak_rate_per_sec: 1.0,
    };

    it('drains constantly and throttles bursts exceeding capacity', async () => {
      // Fire 5 requests -> water fills from 0 to 5
      for (let i = 0; i < 5; i++) {
        const res = await limiter.evaluate('route_webhook', 'worker_1', policy);
        expect(res.allowed).toBe(true);
      }

      // 6th request at t=0 fails because water is full
      const resOver = await limiter.evaluate('route_webhook', 'worker_1', policy);
      expect(resOver.allowed).toBe(false);

      // Advance clock by 2 seconds -> 2 units of water leak
      mockClock.advance(2000);

      // Should now admit up to 2 requests
      const resAfterLeak1 = await limiter.evaluate('route_webhook', 'worker_1', policy);
      expect(resAfterLeak1.allowed).toBe(true);

      const resAfterLeak2 = await limiter.evaluate('route_webhook', 'worker_1', policy);
      expect(resAfterLeak2.allowed).toBe(true);

      const resAfterLeak3 = await limiter.evaluate('route_webhook', 'worker_1', policy);
      expect(resAfterLeak3.allowed).toBe(false);
    });
  });
});
