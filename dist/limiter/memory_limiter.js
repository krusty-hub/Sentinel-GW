import { SystemClock } from './clock.js';
export class MemoryLimiter {
    store = new Map();
    clock;
    totalNodes;
    maxEntries;
    janitorTimer;
    constructor(options = {}) {
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
    async evaluate(routeId, clientId, policy, cost = 1) {
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
    evaluateTokenBucket(key, policy, nowMs, requested) {
        // Capacity_local = ceil(Capacity_global / N_nodes)
        const localCapacity = Math.ceil(policy.capacity / this.totalNodes);
        const localRefillRate = policy.refill_rate_per_sec / this.totalNodes;
        let entry = this.store.get(key);
        let tokens;
        let lastRefillMs;
        if (!entry || entry.type !== 'token_bucket') {
            tokens = localCapacity;
            lastRefillMs = nowMs;
        }
        else {
            const elapsedSec = Math.max(0, nowMs - entry.lastRefillMs) / 1000.0;
            tokens = Math.min(localCapacity, entry.tokens + elapsedSec * localRefillRate);
            lastRefillMs = nowMs;
        }
        let allowed = false;
        let retryAfterMs = 0;
        if (tokens >= requested) {
            allowed = true;
            tokens -= requested;
        }
        else {
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
    evaluateSlidingWindow(key, policy, nowMs) {
        const localLimit = Math.ceil(policy.limit / this.totalNodes);
        const windowMs = policy.window_seconds * 1000;
        let entry = this.store.get(key);
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
        }
        else {
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
    evaluateLeakyBucket(key, policy, nowMs, requested) {
        const localCapacity = Math.ceil(policy.capacity / this.totalNodes);
        const localLeakRate = policy.leak_rate_per_sec / this.totalNodes;
        let entry = this.store.get(key);
        let water;
        let lastLeakMs;
        if (!entry || entry.type !== 'leaky_bucket') {
            water = 0;
            lastLeakMs = nowMs;
        }
        else {
            const elapsedSec = Math.max(0, nowMs - entry.lastLeakMs) / 1000.0;
            water = Math.max(0, entry.water - elapsedSec * localLeakRate);
            lastLeakMs = nowMs;
        }
        let allowed = false;
        let retryAfterMs = 0;
        if (water + requested <= localCapacity) {
            allowed = true;
            water += requested;
        }
        else {
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
    ensureCapacityLimit() {
        if (this.store.size >= this.maxEntries) {
            this.sweepExpired();
            if (this.store.size >= this.maxEntries) {
                // Evict oldest 10%
                const evictCount = Math.ceil(this.maxEntries * 0.1);
                let count = 0;
                for (const k of this.store.keys()) {
                    this.store.delete(k);
                    count++;
                    if (count >= evictCount)
                        break;
                }
            }
        }
    }
    sweepExpired() {
        const nowMs = this.clock.now();
        for (const [key, entry] of this.store.entries()) {
            if (entry.expiresAtMs <= nowMs) {
                this.store.delete(key);
            }
        }
    }
    getStoreSize() {
        return this.store.size;
    }
    clear() {
        this.store.clear();
    }
    async close() {
        if (this.janitorTimer) {
            clearInterval(this.janitorTimer);
        }
        this.store.clear();
    }
}
//# sourceMappingURL=memory_limiter.js.map