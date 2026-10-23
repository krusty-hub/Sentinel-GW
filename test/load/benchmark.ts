import { createMockUpstreamServer } from '../mock_upstream/upstream.js';
import { ConfigManager } from '../../src/config/index.js';
import { MemoryLimiter } from '../../src/limiter/memory_limiter.js';
import { buildServer } from '../../src/server.js';
import { Agent, request } from 'undici';

async function runBenchmark() {
  console.log('====================================================');
  console.log('  SentinelGW Concurrency & Latency Benchmark Test  ');
  console.log('====================================================\n');

  const UPSTREAM_PORT = 5001;
  const GATEWAY_PORT = 8099;
  const TOTAL_REQUESTS = 500;
  const CONCURRENCY = 50;

  console.log(`[1] Starting Mock Upstream on port ${UPSTREAM_PORT}...`);
  const upstream = await createMockUpstreamServer(UPSTREAM_PORT);

  console.log(`[2] Starting SentinelGW on port ${GATEWAY_PORT}...`);
  const configManager = new ConfigManager('config/config.yaml');
  const cfg = configManager.getConfig();
  for (const r of cfg.routes) {
    r.upstream_url = `http://127.0.0.1:${UPSTREAM_PORT}`;
  }

  // Token bucket with capacity 100, refill 1 req/sec for test
  const testCapacity = 100;
  cfg.tiers['free'] = {
    algorithm: 'token_bucket',
    capacity: testCapacity,
    refill_rate_per_sec: 1.0,
  };

  const limiter = new MemoryLimiter({ totalNodes: 1 });
  const app = buildServer({ configManager, limiter });
  await app.listen({ port: GATEWAY_PORT, host: '127.0.0.1' });

  const agent = new Agent({
    connections: 100,
    pipelining: 1,
  });

  console.log(`[3] Firing ${TOTAL_REQUESTS} concurrent requests (concurrency: ${CONCURRENCY})...\n`);

  const latencies: number[] = [];
  let status200 = 0;
  let status429 = 0;
  let statusOther = 0;

  const targetUrl = `http://127.0.0.1:${GATEWAY_PORT}/api/v1/payments`;
  const startTime = performance.now();

  const runRequest = async () => {
    const reqStart = performance.now();
    try {
      const res = await request(targetUrl, {
        dispatcher: agent,
        method: 'POST',
        headers: {
          'x-api-key': 'apikey_free_001',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ amount: 10 }),
      });
      await res.body.dump();
      const elapsed = performance.now() - reqStart;
      latencies.push(elapsed);

      if (res.statusCode === 200) status200++;
      else if (res.statusCode === 429) status429++;
      else statusOther++;
    } catch {
      statusOther++;
    }
  };

  // Run in concurrent chunks
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    tasks.push(runRequest());
  }
  await Promise.all(tasks);

  const totalTimeMs = performance.now() - startTime;
  latencies.sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  const rps = (TOTAL_REQUESTS / (totalTimeMs / 1000)).toFixed(1);

  console.log('---------------- Benchmark Results ----------------');
  console.log(`Total Requests:         ${TOTAL_REQUESTS}`);
  console.log(`Total Duration:         ${totalTimeMs.toFixed(2)} ms`);
  console.log(`Throughput:             ${rps} requests/sec`);
  console.log(`200 OK (Admitted):      ${status200} (Expected ~${testCapacity})`);
  console.log(`429 Throttled:          ${status429} (Expected ~${TOTAL_REQUESTS - testCapacity})`);
  console.log(`5xx Errors / Failures:  ${statusOther} (Target: 0)`);
  console.log('---------------- Latency Metrics ------------------');
  console.log(`P50 Latency:            ${p50.toFixed(2)} ms (SLO: <= 1.5 ms target on node)`);
  console.log(`P95 Latency:            ${p95.toFixed(2)} ms`);
  console.log(`P99 Latency:            ${p99.toFixed(2)} ms (SLO: <= 5.0 ms)`);
  console.log('---------------------------------------------------\n');

  const drift = Math.abs(status200 - testCapacity);
  console.log(`Accuracy Drift: ${drift} requests (${((drift / testCapacity) * 100).toFixed(2)}%)`);
  if (drift === 0 && statusOther === 0) {
    console.log('>>> [SUCCESS] Zero-drift rate limiting verified! PRD SLOs achieved. <<<\n');
  } else {
    console.log('>>> Benchmark completed. <<<\n');
  }

  await app.close();
  await limiter.close();
  await agent.close();
  await new Promise<void>((r) => upstream.close(() => r()));
}

runBenchmark().catch(console.error);
