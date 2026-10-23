import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { CircuitBreaker } from './circuit_breaker.js';
import { MemoryLimiter } from './memory_limiter.js';
import {
  IRateLimiter,
  RateLimitPolicy,
  RateLimitResult,
  CircuitState,
} from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface RedisLimiterOptions {
  redisClient?: Redis;
  redisAddress?: string;
  commandTimeoutMs?: number;
  circuitBreaker?: CircuitBreaker;
  fallbackLimiter: MemoryLimiter;
  scriptsDir?: string;
  onRedisLatency?: (latencySeconds: number, backend: 'redis' | 'local_l1') => void;
}

export class RedisLimiter implements IRateLimiter {
  private redis: Redis;
  private isExternalRedis: boolean;
  private readonly commandTimeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;
  private readonly fallbackLimiter: MemoryLimiter;
  private readonly onRedisLatency?: (latencySeconds: number, backend: 'redis' | 'local_l1') => void;

  private scripts: Map<string, { content: string; sha: string }> = new Map();
  private isScriptsLoaded: boolean = false;

  constructor(options: RedisLimiterOptions) {
    this.commandTimeoutMs = options.commandTimeoutMs ?? 15;
    this.fallbackLimiter = options.fallbackLimiter;
    this.circuitBreaker = options.circuitBreaker ?? new CircuitBreaker();
    this.onRedisLatency = options.onRedisLatency;

    if (options.redisClient) {
      this.redis = options.redisClient;
      this.isExternalRedis = true;
    } else {
      const address = options.redisAddress ?? '127.0.0.1:6379';
      const [host, portStr] = address.split(':');
      const port = parseInt(portStr || '6379', 10);
      this.redis = new Redis({
        host,
        port,
        connectTimeout: 500,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
      });
      this.isExternalRedis = false;
    }

    const scriptsPath = options.scriptsDir ?? path.join(__dirname, 'scripts');
    this.loadScriptFiles(scriptsPath);
  }

  private loadScriptFiles(scriptsDir: string): void {
    const scriptFiles: Record<string, string> = {
      token_bucket: 'token_bucket.lua',
      sliding_window_counter: 'sliding_window_counter.lua',
      leaky_bucket: 'leaky_bucket.lua',
    };

    for (const [algo, fileName] of Object.entries(scriptFiles)) {
      const filePath = path.join(scriptsDir, fileName);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const sha = crypto.createHash('sha1').update(content).digest('hex');
        this.scripts.set(algo, { content, sha });
      }
    }
  }

  public async preloadScripts(): Promise<void> {
    if (this.isScriptsLoaded) return;
    try {
      for (const [algo, script] of this.scripts.entries()) {
        const loadedSha = await this.redis.script('LOAD', script.content);
        if (typeof loadedSha === 'string') {
          script.sha = loadedSha;
        }
      }
      this.isScriptsLoaded = true;
    } catch {
      // Scripts will be lazily loaded or evaluated via fallback if Redis is down initially
    }
  }

  async evaluate(
    routeId: string,
    clientId: string,
    policy: RateLimitPolicy,
    cost: number = 1
  ): Promise<RateLimitResult> {
    const startTime = performance.now();

    // Check circuit breaker state first
    if (!this.circuitBreaker.shouldAllowExecution()) {
      const fallbackResult = await this.fallbackLimiter.evaluate(routeId, clientId, policy, cost);
      const elapsedSec = (performance.now() - startTime) / 1000;
      this.onRedisLatency?.(elapsedSec, 'local_l1');
      return fallbackResult;
    }

    try {
      const result = await this.executeWithTimeout(
        () => this.executeRedisLimiter(routeId, clientId, policy, cost),
        this.commandTimeoutMs
      );

      const elapsedSec = (performance.now() - startTime) / 1000;
      this.onRedisLatency?.(elapsedSec, 'redis');
      this.circuitBreaker.recordSuccess();
      return result;
    } catch (err) {
      const elapsedSec = (performance.now() - startTime) / 1000;
      this.onRedisLatency?.(elapsedSec, 'local_l1');
      this.circuitBreaker.recordFailure();

      // Gracefully degrade to local L1 in-memory limiter
      return await this.fallbackLimiter.evaluate(routeId, clientId, policy, cost);
    }
  }

  private async executeRedisLimiter(
    routeId: string,
    clientId: string,
    policy: RateLimitPolicy,
    cost: number
  ): Promise<RateLimitResult> {
    const algo = policy.algorithm;
    const scriptInfo = this.scripts.get(algo);
    if (!scriptInfo) {
      throw new Error(`Unsupported rate limit algorithm: ${algo}`);
    }

    let key: string;
    let args: (string | number)[];
    let limit: number;
    let policyDesc: string;

    switch (policy.algorithm) {
      case 'token_bucket':
        key = `rl:tb:${routeId}:${clientId}`;
        args = [policy.capacity, policy.refill_rate_per_sec, cost];
        limit = policy.capacity;
        policyDesc = `${policy.capacity};w=1;alg=token_bucket`;
        break;

      case 'sliding_window_counter':
        key = `rl:swc:${routeId}:${clientId}`;
        args = [policy.limit, policy.window_seconds * 1000];
        limit = policy.limit;
        policyDesc = `${policy.limit};w=${policy.window_seconds};alg=sliding_window_counter`;
        break;

      case 'leaky_bucket':
        key = `rl:lb:${routeId}:${clientId}`;
        args = [policy.capacity, policy.leak_rate_per_sec, cost];
        limit = policy.capacity;
        policyDesc = `${policy.capacity};w=1;alg=leaky_bucket`;
        break;
    }

    // Try EVALSHA first
    let res: unknown;
    try {
      res = await this.redis.evalsha(scriptInfo.sha, 1, key, ...args);
    } catch (err: unknown) {
      const isNoScript =
        err instanceof Error &&
        (err.message.includes('NOSCRIPT') || err.message.includes('No matching script'));

      if (isNoScript) {
        // Transparent fallback: evaluate script and re-cache sha
        res = await this.redis.eval(scriptInfo.content, 1, key, ...args);
        try {
          const loadedSha = await this.redis.script('LOAD', scriptInfo.content);
          if (typeof loadedSha === 'string') {
            scriptInfo.sha = loadedSha;
          }
        } catch {
          // ignore SCRIPT LOAD error here
        }
      } else {
        throw err;
      }
    }

    if (!Array.isArray(res) || res.length < 4) {
      throw new Error(`Invalid response format from Redis Lua script for ${algo}`);
    }

    const [allowedNum, remainingNum, retryAfterMsNum, resetEpochSecNum] = res;

    return {
      allowed: Number(allowedNum) === 1,
      limit,
      remaining: Math.max(0, Number(remainingNum)),
      retryAfterMs: Math.max(0, Number(retryAfterMsNum)),
      resetEpochSec: Number(resetEpochSecNum),
      backend: 'redis',
      policyDescription: policyDesc,
    };
  }

  private executeWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`Redis command timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      fn()
        .then((result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(result);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
    });
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  public getCircuitState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  public getFallbackLimiter(): MemoryLimiter {
    return this.fallbackLimiter;
  }

  public async close(): Promise<void> {
    await this.fallbackLimiter.close?.();
    if (!this.isExternalRedis) {
      try {
        await this.redis.quit();
      } catch {
        this.redis.disconnect();
      }
    }
  }
}
