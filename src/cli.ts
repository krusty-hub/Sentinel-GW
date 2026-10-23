import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ConfigManager } from './config/index.js';
import { MemoryLimiter } from './limiter/memory_limiter.js';
import { buildServer } from './server.js';
import { FastifyInstance } from 'fastify';

async function getOrStartGateway(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  // 1. Check if SentinelGW is already running on port 8080
  try {
    const res = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(500) });
    if (res.ok) {
      return { baseUrl: 'http://127.0.0.1:8080', close: async () => {} };
    }
  } catch {
    // Gateway is not running, we will start it automatically
  }

  // 2. Automatically launch the gateway in-process
  console.log('⚡ Starting SentinelGW engine in the background...\n');
  const configManager = new ConfigManager('config/config.yaml');
  const limiter = new MemoryLimiter({ totalNodes: 1 });
  const app: FastifyInstance = buildServer({ configManager, limiter });

  await app.listen({ port: 8080, host: '127.0.0.1' });

  return {
    baseUrl: 'http://127.0.0.1:8080',
    close: async () => {
      await app.close();
      await limiter.close();
    },
  };
}

async function main() {
  console.clear();
  console.log('====================================================');
  console.log('       🛡️  SentinelGW Easy URL Tester CLI           ');
  console.log('====================================================\n');

  let targetUrl = process.argv[2];
  let countStr = process.argv[3];

  if (!targetUrl) {
    const rl = readline.createInterface({ input, output });

    console.log('💡 Tip: Enter any website or API URL to test it through SentinelGW.\n');
    const inputUrl = await rl.question('👉 Enter website or API URL [press Enter for https://jsonplaceholder.typicode.com/todos/1]: ');
    targetUrl = inputUrl.trim() || 'https://jsonplaceholder.typicode.com/todos/1';

    const inputCount = await rl.question('👉 How many requests to send? [press Enter for 5]: ');
    countStr = inputCount.trim() || '5';

    rl.close();
  }

  const count = Math.min(100, Math.max(1, parseInt(countStr || '5', 10)));

  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }

  // Ensure gateway is running
  const gateway = await getOrStartGateway();

  console.log(`🌐 Target URL:     ${targetUrl}`);
  console.log(`🔢 Total Requests: ${count}`);
  console.log(`🛡️ Rate Limiter:   Active`);
  console.log('----------------------------------------------------\n');

  let successCount = 0;
  let throttledCount = 0;
  let lastSuccessData: string | undefined = undefined;
  let lastErrorData: string | undefined = undefined;

  for (let i = 1; i <= count; i++) {
    const proxyUrl = `${gateway.baseUrl}/proxy?url=${encodeURIComponent(targetUrl)}`;

    try {
      const res = await fetch(proxyUrl);
      const remaining = res.headers.get('x-ratelimit-remaining') ?? '0';
      const limit = res.headers.get('x-ratelimit-limit') ?? '5';
      const retryAfter = res.headers.get('retry-after');
      const text = await res.text();

      if (res.status === 200) {
        successCount++;
        console.log(`[Request ${i}/${count}] ✅ SUCCESS (200 OK) | Tokens remaining: ${remaining}/${limit}`);
        lastSuccessData = text;
      } else if (res.status === 429) {
        throttledCount++;
        console.log(`[Request ${i}/${count}] 🛑 BLOCKED (429 Rate Limit) | Bucket empty! Retry in ${retryAfter || '1'}s`);
        lastErrorData = text;
      } else {
        console.log(`[Request ${i}/${count}] ⚠️ Status ${res.status}: ${res.statusText}`);
        lastErrorData = text;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[Request ${i}/${count}] ❌ Error: ${msg}`);
    }

    // Small delay between requests
    await new Promise((r) => setTimeout(r, 60));
  }

  console.log('\n----------------------------------------------------');
  console.log('📊 Summary:');
  console.log(`   - Allowed (200 OK):            ${successCount}`);
  console.log(`   - Rate-Limited (429 Blocked):  ${throttledCount}`);
  console.log('----------------------------------------------------');

  const dataToShow = lastSuccessData || lastErrorData;
  if (dataToShow) {
    if (lastSuccessData) {
      console.log('📦 Data Received from Website:\n');
      try {
        const parsed = JSON.parse(dataToShow);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        // If HTML, extract the title
        const titleMatch = dataToShow.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleMatch) {
          console.log(`📄 Web Page Title: "${titleMatch[1].trim()}"`);
        }
        console.log(`📄 Raw Preview (first 300 chars):\n${dataToShow.slice(0, 300).trim()}...`);
      }
    } else {
      console.log('🛑 Rate Limit Response Body:\n');
      try {
        const parsed = JSON.parse(dataToShow);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(dataToShow.slice(0, 300));
      }
    }
  }

  console.log('\n====================================================');
  console.log('🎉 Test finished!');
  console.log('====================================================\n');

  await gateway.close();
}

main().catch(console.error);
