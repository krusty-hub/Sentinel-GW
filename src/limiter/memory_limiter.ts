import { Clock, SystemClock } from './clock.js';
import {
  IRateLimiter,
  RateLimitPolicy,
  RateLimitResult,
  TokenBucketPolicy,
  SlidingWindowPolicy,
  LeakyBucketPolicy,
} from './types.js';

interface MemoryTokenBucketEntry {
  type: 'token_bucket';
  tokens: number;
  lastRefillMs: number;
  expiresAtMs: number;
}

interface MemorySlidingWindowEntry {
  type: 'sliding_window';
  windowMs: number;
  counts: Map<number, number>; // windowIndex -> count
  expiresAtMs: number;
}

interface MemoryLeakyBucketEntry {
  type: 'leaky_bucket';
  water: number;
  lastLeakMs: number;
  expiresAtMs: number;
}

type MemoryEntry = MemoryTokenBucketEntry | MemorySlidingWindowEntry | MemoryLeakyBucketEntry;

export class MemoryLimiter implements IRateLimiter {
  private readonly store: Map<string, MemoryEntry> = new Map();
  private readonly clock: Clock;
  private readonly totalNodes: number;
  private readonly maxEntries: number;
  private janitorTimer?: NodeJS.Timeout;

  constructor(options: {
    clock?: Clock;
    totalNodes?: number;
    maxEntries?: number;
    janitorIntervalMs?: number;
  } = {}) {
    this.clock = options.clock ?? new SystemClock();
    this.totalNodes = Math.max(1, options.totalNodes ?? 1);
    this.maxEntries = options.maxEntries ?? 50000;

    const janitorMs = options.janitorIntervalMs ?? 60000;
    if (janitorMs > 0 && typeof setInterval !== 'undefined') {
      this.janitorTimer = setInterval(() => this.sweepExpired(), janitorMs);
      if (this.janitorTimer.unref) {
        this.janitorTimer.unref();
      }
    }
  }

  async evaluate(
    routeId: string,
    clientId: string,
    policy: RateLimitPolicy,
    cost: number = 1
  ): Promise<RateLimitResult> {
    const nowMs = this.clock.now();
    const key = `local:${policy.algorithm}:${routeId}:${clientId}`;

    this.ensureCapacityLimit();

    switch (policy.algorithm) {
      case 'token_bucket':
        return this.evaluateTokenBucket(key, policy, nowMs, cost);
      case 'sliding_window_counter':
        return this.evaluateSlidingWindow(key, policy, nowMs);
      case 'leaky_bucket':
        return this.evaluateLeakyBucket(key, policy, nowMs, cost);
    }
  }

  private evaluateTokenBucket(
    key: string,
    policy: TokenBucketPolicy,
    nowMs: number,
    requested: number
  ): RateLimitResult {
    // Capacity_local = ceil(Capacity_global / N_nodes)
    const localCapacity = Math.ceil(policy.capacity / this.totalNodes);
    const localRefillRate = policy.refill_rate_per_sec / this.totalNodes;

    let entry = this.store.get(key) as MemoryTokenBucketEntry | undefined;

    let tokens: number;
    let lastRefillMs: number;

    if (!entry || entry.type !== 'token_bucket') {
      tokens = localCapacity;
      lastRefillMs = nowMs;
    } else {
      const elapsedSec = Math.max(0, nowMs - entry.lastRefillMs) / 1000.0;
      tokens = Math.min(localCapacity, entry.tokens + elapsedSec * localRefillRate);
      lastRefillMs = nowMs;
    }

    let allowed = false;
    let retryAfterMs = 0;

    if (tokens >= requested) {
      allowed = true;
      tokens -= requested;
    } else {
      allowed = false;
      retryAfterMs = Math.ceil(((requested - tokens) / localRefillRate) * 1000);
    }

    const fillTimeMs = Math.ceil(((localCapacity - tokens) / localRefillRate) * 1000);
    const ttlMs = Math.max(1000, fillTimeMs + 1000);
    const expiresAtMs = nowMs + ttlMs;
    const resetEpochSec = Math.ceil((nowMs + fillTimeMs) / 1000);

    this.store.set(key, {
      type: 'token_bucket',
      tokens,
      lastRefillMs,
      expiresAtMs,
    });

    return {
      allowed,
      limit: localCapacity,
      remaining: Math.floor(tokens),
      retryAfterMs,
      resetEpochSec,
      backend: 'local_l1',
      policyDescription: `${localCapacity};w=1;alg=token_bucket;fallback=true`,
    };
  }

  private evaluateSlidingWindow(
    key: string,
    policy: SlidingWindowPolicy,
    nowMs: number
  ): RateLimitResult {
    const localLimit = Math.ceil(policy.limit / this.totalNodes);
    const windowMs = policy.window_seconds * 1000;

    let entry = this.store.get(key) as MemorySlidingWindowEntry | undefined;
    if (!entry || entry.type !== 'sliding_window' || entry.windowMs !== windowMs) {
      entry = {
        type: 'sliding_window',
        windowMs,
        counts: new Map(),
        expiresAtMs: nowMs + windowMs * 2,
      };
      this.store.set(key, entry);
    }

    const currentWindow = Math.floor(nowMs / windowMs);
    const prevWindow = currentWindow - 1;

    // Prune stale windows older than prevWindow
    for (const wIdx of entry.counts.keys()) {
      if (wIdx < prevWindow) {
        entry.counts.delete(wIdx);
      }
    }

    const currCount = entry.counts.get(currentWindow) || 0;
    const prevCount = entry.counts.get(prevWindow) || 0;

    const elapsedInWindow = nowMs % windowMs;
    const weight = (windowMs - elapsedInWindow) / windowMs;
    let estimatedCount = Math.floor(prevCount * weight) + currCount;

    let allowed = false;
    let retryAfterMs = 0;

    if (estimatedCount < localLimit) {
      allowed = true;
      entry.counts.set(currentWindow, currCount + 1);
      estimatedCount += 1;
    } else {
      allowed = false;
      retryAfterMs = windowMs - elapsedInWindow;
    }

    entry.expiresAtMs = (currentWindow + 2) * windowMs;
    const remaining = Math.max(0, localLimit - estimatedCount);
    const resetEpochSec = Math.ceil(((currentWindow + 1) * windowMs) / 1000);

    return {
      allowed,
      limit: localLimit,
      remaining,
      retryAfterMs,
      resetEpochSec,
      backend: 'local_l1',
      policyDescription: `${localLimit};w=${policy.window_seconds};alg=sliding_window_counter;fallback=true`,
    };
  }

  private evaluateLeakyBucket(
    key: string,
    policy: LeakyBucketPolicy,
    nowMs: number,
    requested: number
  ): RateLimitResult {
    const localCapacity = Math.ceil(policy.capacity / this.totalNodes);
    const localLeakRate = policy.leak_rate_per_sec / this.totalNodes;

    let entry = this.store.get(key) as MemoryLeakyBucketEntry | undefined;

    let water: number;
    let lastLeakMs: number;

    if (!entry || entry.type !== 'leaky_bucket') {
      water = 0;
      lastLeakMs = nowMs;
    } else {
      const elapsedSec = Math.max(0, nowMs - entry.lastLeakMs) / 1000.0;
      water = Math.max(0, entry.water - elapsedSec * localLeakRate);
      lastLeakMs = nowMs;
    }

    let allowed = false;
    let retryAfterMs = 0;

    if (water + requested <= localCapacity) {
      allowed = true;
      water += requested;
    } else {
      allowed = false;
      retryAfterMs = Math.ceil(((water + requested - localCapacity) / localLeakRate) * 1000);
    }

    const drainTimeMs = Math.ceil((water / localLeakRate) * 1000);
    const ttlMs = Math.max(1000, drainTimeMs + 1000);
    const expiresAtMs = nowMs + ttlMs;
    const resetEpochSec = Math.ceil((nowMs + drainTimeMs) / 1000);

    this.store.set(key, {
      type: 'leaky_bucket',
      water,
      lastLeakMs,
      expiresAtMs,
    });

    return {
      allowed,
      limit: localCapacity,
      remaining: Math.max(0, Math.floor(localCapacity - water)),
      retryAfterMs,
      resetEpochSec,
      backend: 'local_l1',
      policyDescription: `${localCapacity};w=1;alg=leaky_bucket;fallback=true`,
    };
  }

  private ensureCapacityLimit(): void {
    if (this.store.size >= this.maxEntries) {
      this.sweepExpired();
      if (this.store.size >= this.maxEntries) {
        // Evict oldest 10%
        const evictCount = Math.ceil(this.maxEntries * 0.1);
        let count = 0;
        for (const k of this.store.keys()) {
          this.store.delete(k);
          count++;
          if (count >= evictCount) break;
        }
      }
    }
  }

  public sweepExpired(): void {
    const nowMs = this.clock.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.store.delete(key);
      }
    }
  }

  public getStoreSize(): number {
    return this.store.size;
  }

  public clear(): void {
    this.store.clear();
  }

  async close(): Promise<void> {
    if (this.janitorTimer) {
      clearInterval(this.janitorTimer);
    }
    this.store.clear();
  }
}
