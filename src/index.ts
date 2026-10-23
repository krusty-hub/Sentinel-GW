import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ConfigManager } from './config/index.js';
import { MemoryLimiter } from './limiter/memory_limiter.js';
import { CircuitBreaker } from './limiter/circuit_breaker.js';
import { RedisLimiter } from './limiter/redis_limiter.js';
import { TelemetryMetrics } from './telemetry/metrics.js';
import { StructuredLogger } from './telemetry/logger.js';
import { buildServer } from './server.js';
import { CircuitState } from './limiter/types.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const configPath =
    process.env.CONFIG_PATH ||
    path.resolve(process.cwd(), 'config', 'config.yaml');

  console.log(`[SentinelGW] Loading configuration from ${configPath}`);
  const configManager = new ConfigManager(configPath);
  const config = configManager.getConfig();

  const logger = new StructuredLogger(config.server.node_id);
  const metrics = new TelemetryMetrics();

  // Create L1 In-Memory Fallback Limiter
  const fallbackLimiter = new MemoryLimiter({
    totalNodes: config.server.total_nodes,
    maxEntries: 50000,
    janitorIntervalMs: 60000,
  });

  // Create Circuit Breaker
  const circuitBreaker = new CircuitBreaker({
    failureThreshold: config.redis.circuit_breaker.failure_threshold,
    recoveryWindowMs: config.redis.circuit_breaker.recovery_window_ms,
    onStateChange: (from: CircuitState, to: CircuitState) => {
      logger.logCircuitTransition(from, to);
      metrics.circuitBreakerState.set(to);
    },
  });

  // Create Distributed Redis Limiter
  const redisLimiter = new RedisLimiter({
    redisAddress: config.redis.address,
    commandTimeoutMs: config.redis.command_timeout_ms,
    circuitBreaker,
    fallbackLimiter,
    scriptsDir: path.join(__dirname, 'limiter', 'scripts'),
    onRedisLatency: (latencySec, backend) => {
      metrics.ratelimitLatencySeconds.labels(backend).observe(latencySec);
    },
  });

  // Preload Lua scripts in Redis asynchronously
  redisLimiter.preloadScripts().catch((err) => {
    logger.info('Redis not immediately reachable for script preloading; will use L1 or retry on connect', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const app = buildServer({
    configManager,
    limiter: redisLimiter,
    circuitBreaker,
    metrics,
    logger,
  });

  const port = parseInt(process.env.PORT || config.server.port.toString(), 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
    logger.info(`SentinelGW running on http://${host}:${port}`, {
      node_id: config.server.node_id,
      total_nodes: config.server.total_nodes,
      redis_addr: config.redis.address,
      routes_count: config.routes.length,
    });
  } catch (err) {
    logger.error('Failed to start server', err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    try {
      await app.close();
      await redisLimiter.close();
      logger.info('Graceful shutdown completed successfully.');
      process.exit(0);
    } catch (err) {
      logger.error('Error during graceful shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // SIGHUP live configuration reload (non-Windows and Windows simulation)
  process.on('SIGHUP', () => {
    logger.info('Received SIGHUP, reloading configuration...');
    try {
      configManager.reload();
    } catch (err) {
      logger.error('Failed to reload configuration on SIGHUP', err);
    }
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
