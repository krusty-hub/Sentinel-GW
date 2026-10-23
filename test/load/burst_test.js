import http from 'k6/http';
import { check } from 'k6';

// Multi-Node Concurrency Torture Test (k6) - PRD Test Suite 7.2
// Run against Nginx Load Balancer on http://localhost:80 or direct cluster nodes

export const options = {
  scenarios: {
    burst_torture: {
      executor: 'per-vu-iterations',
      vus: 500,
      iterations: 1,
      maxDuration: '2s',
    },
  },
  thresholds: {
    // 0% dropped or internal server errors
    'http_req_failed{status:500}': ['count==0'],
  },
};

export default function () {
  const url = __ENV.TARGET_URL || 'http://localhost:80/api/v1/payments';
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'apikey_pro_8821', // Pro tier token bucket capacity: 500, or test route configured
    },
  };

  const payload = JSON.stringify({
    account_id: 'acc_01',
    amount: 50,
  });

  const res = http.post(url, payload, params);

  check(res, {
    'is status 200 or 429': (r) => r.status === 200 || r.status === 429,
    'has ratelimit headers': (r) => r.headers['X-Ratelimit-Limit'] !== undefined,
  });
}
