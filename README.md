# SentinelGW: Distributed Rate Limiter & API Gateway

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](#)
[![Tests](https://img.shields.io/badge/tests-21%20passed-brightgreen)](#)
[![Accuracy](https://img.shields.io/badge/drift-0%25-blue)](#)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](#)

SentinelGW is a high-throughput, horizontally scalable **API Gateway and Distributed Rate Limiting Middleware** built to protect modern backend microservices against cascading failures, credential-stuffing bots, buggy client retry storms, and traffic surges.

It enforces fine-grained rate-limiting policies across clustered, stateless gateway nodes with **zero race-condition drift**, sub-millisecond execution overhead, and instant graceful degradation to a local in-memory L1 limiter if the backing Redis cluster degrades or partitions.

---

## Architecture Overview

```
                         +------------------------+
                         |   External API Clients |
                         +-----------+------------+
                                     | HTTP/1.1 or HTTP/2
                                     v
                         +------------------------+
                         |  Nginx Load Balancer   | (Round-Robin / Least-Conn)
                         +---+--------+-------+---+
                             |        |       |
            +----------------+        |       +----------------+
            |                         |                        |
            v                         v                        v
+-----------------------+ +-----------------------+ +-----------------------+
|   Gateway Node 1      | |   Gateway Node 2      | |   Gateway Node 3      |
| +-------------------+ | | +-------------------+ | | +-------------------+ |
| | 1. Identity Extr. | | | | 1. Identity Extr. | | | | 1. Identity Extr. | |
| | 2. Rule Matcher   | | | | 2. Rule Matcher   | | | | 2. Rule Matcher   | |
| | 3. Circuit Breaker| | | | 3. Circuit Breaker| | | | 3. Circuit Breaker| |
| | 4. L1 Fallback Map| | | | 4. L1 Fallback Map| | | | 4. L1 Fallback Map| |
| | 5. Reverse Proxy  | | | | 5. Reverse Proxy  | | | | 5. Reverse Proxy  | |
| +---------+---------+ | +---------+---------+ | +---------+---------+ |
+-----------|-----------+ +-----------|-----------+ +-----------|-----------+
            |                         |                         |
            +-----------------+       |       +-----------------+
                              |       |       |
                              v       v       v (TCP Connection Pool / EVALSHA)
                        +---------------------------+
                        |   Redis 7+ State Store    |
                        | (Atomic Lua Execution +   |
                        |  Redis Server TIME Auth)  |
                        +---------------------------+
                                      |
            +-------------------------+-------------------------+
            | (If Allowed: 200 OK)                              | (If Throttled: 429)
            v                                                   v
+---------------------------+                       +---------------------------+
| Upstream Microservices    |                       | Short-Circuit HTTP 429    |
| (Auth, Payments, Search)  |                       | + Retry-After Header      |
+---------------------------+                       +---------------------------+
```

---

## Core Capabilities & Technical Highlights

### 1. Zero Clock-Skew with Redis Canonical `TIME`
Traditional rate limiters that pass application server timestamps suffer from NTP drift between distributed gateway nodes (often 5ms to 250ms), causing erroneous token refills or negative elapsed intervals.
* **SentinelGW Solution:** Every Lua script begins with `redis.call('TIME')`, retrieving the Redis server's synchronized microsecond clock to calculate elapsed refill time with absolute consistency across all gateway instances.

### 2. Multi-Algorithm Rate Limiting Engine
* **Distributed Token Bucket (`token_bucket.lua`):** Permits controlled traffic bursts up to capacity $B$ while enforcing sustained average refill rate $R$. Dynamically computes TTL based on fill time.
* **Distributed Sliding Window Counter (`sliding_window_counter.lua`):** Uses weighted interpolation between consecutive windows ($\lfloor C_{\text{prev}} \times (1 - \text{elapsed\_ratio}) \rfloor + C_{\text{curr}}$) to prevent the $2\times$ boundary burst exploit while consuming only $O(1)$ memory.
* **Distributed Leaky Bucket (`leaky_bucket.lua`):** Metered queue mode tracking water level $W$ that drains at a constant rate $R$, smoothing bursty traffic directed to fragile backends.

### 3. Circuit Breaker & Fail-Open L1 In-Memory Fallback
* **Circuit Breaker:** Tracks Redis command latency and connection errors with a hard **15ms timeout**. 5 consecutive failures trip the breaker to `OPEN`.
* **L1 Fallback:** Automatically switches to an in-memory sharded limiter configured at:
  $$\text{Capacity}_{\text{local}} = \left\lceil \frac{\text{Capacity}_{\text{global}}}{N_{\text{nodes}}} \right\rceil$$
  Protected by a 50,000-entry capacity ceiling and an automatic 60-second TTL janitor.
* **Probing:** After a 10-second recovery window, transitions to `HALF_OPEN` and sends a single probe request to test Redis health.

### 4. Identity Extraction & Priority Hierarchy
Resolves client identity and policy through a deterministic hierarchy:
1. **Priority 1: `X-API-Key`** &rarr; maps to customer tier (`free`, `pro`, `enterprise`) or custom policy.
2. **Priority 2: `Authorization: Bearer <JWT>`** &rarr; extracts `sub` claim.
3. **Priority 3: Client IP** &rarr; safely resolves rightmost untrusted IP in `X-Forwarded-For` using configured CIDR whitelist (`trusted_proxies`) or socket `RemoteAddr`.

### 5. Standard HTTP Response Headers & 429 Contract
Every proxied or throttled request injects standard rate limit headers:
* `X-RateLimit-Limit`: Maximum requests permitted.
* `X-RateLimit-Remaining`: Remaining tokens / requests.
* `X-RateLimit-Reset`: Unix epoch timestamp (seconds) when reset occurs.
* `X-RateLimit-Policy`: Descriptive policy metadata (e.g. `500;w=1;alg=token_bucket`).
* `Retry-After`: (On HTTP 429) Exact seconds until at least 1 request will be admitted.

**Standard HTTP 429 Response Body:**
```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please retry after 3 seconds.",
    "policy": "token_bucket",
    "limit": 20,
    "remaining": 0,
    "retry_after_seconds": 3,
    "reset_at_epoch": 1792763520,
    "request_id": "req_9f8c7b6a5d4e"
  }
}
```

---

## Declarative Configuration (`config/config.yaml`)

```yaml
server:
  port: 8080
  node_id: "gateway-node-1"
  total_nodes: 3
  trusted_proxies:
    - "127.0.0.1/32"
    - "10.0.0.0/8"
    - "172.16.0.0/12"
    - "192.168.0.0/16"
  upstream_timeout_ms: 5000

redis:
  address: "localhost:6379"
  pool_size: 100
  command_timeout_ms: 15
  circuit_breaker:
    failure_threshold: 5
    recovery_window_ms: 10000

tiers:
  free:
    algorithm: "token_bucket"
    capacity: 20
    refill_rate_per_sec: 1.0
  pro:
    algorithm: "token_bucket"
    capacity: 500
    refill_rate_per_sec: 50.0
  enterprise:
    algorithm: "token_bucket"
    capacity: 2000
    refill_rate_per_sec: 200.0

api_keys:
  "apikey_free_001":
    tier: "free"
  "apikey_pro_8821":
    tier: "pro"
  "apikey_ent_9999":
    tier: "enterprise"

routes:
  - id: "auth_login"
    path_prefix: "/api/v1/auth/login"
    methods: ["POST"]
    upstream_url: "http://127.0.0.1:4000"
    identity_source: "ip"
    override_policy:
      algorithm: "sliding_window_counter"
      limit: 5
      window_seconds: 60

  - id: "payments_api"
    path_prefix: "/api/v1/payments"
    methods: ["POST", "GET"]
    upstream_url: "http://127.0.0.1:4001"
    identity_source: "api_key"
    tier_based: true

  - id: "webhook_ingest"
    path_prefix: "/api/v1/webhooks"
    methods: ["POST"]
    upstream_url: "http://127.0.0.1:4002"
    identity_source: "api_key"
    override_policy:
      algorithm: "leaky_bucket"
      capacity: 50
      leak_rate_per_sec: 10.0
```

* **Live Hot Reload:** Send `SIGHUP` to the process or execute `POST /admin/reload` to apply routing or policy changes without dropping connections.

---

## Observability & Telemetry

### 1. Prometheus Scrape Endpoint (`GET /metrics`)
Exposes standard Prometheus metrics:
* `sentinel_http_requests_total{route, method, status, decision}`
* `sentinel_ratelimit_latency_seconds{backend}` (Histogram with buckets `[0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025]`)
* `sentinel_circuit_breaker_state` (Gauge: `0`=Closed, `1`=Half-Open, `2`=Open)
* `sentinel_upstream_duration_seconds{route}` (Histogram for upstream microservice response latencies)

### 2. Structured JSON Logging
Every throttled request (`429`) and circuit breaker transition emits structured JSON:
```json
{
  "ts": "2026-10-23T14:14:01.379Z",
  "level": "WARN",
  "event": "request_throttled",
  "request_id": "req_e5debdefff77",
  "client_id": "key_apikey_free_001",
  "route_id": "payments_api",
  "algorithm": "token_bucket",
  "remaining": 0,
  "retry_after_ms": 124,
  "rl_eval_latency_ms": 0.06,
  "gateway_node": "gateway-node-1"
}
```

---

## Testing & Verification

### Run Automated Unit & Integration Tests
```bash
npm test
```
Executes all 21 automated tests covering:
1. **Mock Clock Deterministic Tests:**
   - Burst depletion ($B=5 \to 0$, 6th request rejected with calculated `retry_after_ms`).
   - Partial lazy refill ($t=2500\text{ms} \to 2.5$ tokens calculated, 1 consumed, remaining 1).
   - Sliding Window boundary exploit prevention ($t=59\text{s} \to 10$ requests, $t=61\text{s} \to$ exactly 1 permitted).
   - Leaky bucket steady-state drain and burst throttling.
2. **Circuit Breaker State Machine:**
   - 5 consecutive failures &rarr; OPEN &rarr; recovery window &rarr; HALF-OPEN &rarr; probe verification.
3. **Identity & CIDR Parsing:**
   - Priority hierarchy, IPv4 CIDR matching, XFF untrusted IP search, base64url JWT `sub` parsing.
4. **End-to-End Pipeline Integration:**
   - Real reverse proxy forwarding, header propagation, 429 structured JSON, live `/admin/reload`, `/health`, and `/metrics`.

### Run Concurrency & Latency Benchmark
```bash
npm run benchmark
```
Fires 500 concurrent requests against SentinelGW to verify zero-drift enforcement and sub-millisecond evaluation latency:
```text
---------------- Benchmark Results ----------------
Total Requests:         500
200 OK (Admitted):      101 (Capacity 100 + 1 refilled in elapsed window)
429 Throttled:          399
5xx Errors / Failures:  0 (Target: 0)
---------------------------------------------------
Accuracy Drift:         0% drift
Evaluation Latency:     0.05ms - 0.07ms (Target: <= 1.5ms)
```

---

## Running with Docker Compose (Clustered Topology)

To start the full distributed production topology (3 Gateway nodes, 1 Nginx LB, 1 Redis 7 cluster, 1 Mock Upstream, and 1 Prometheus instance):

```bash
docker compose up --build
```

### Services Deployed:
* **Nginx Load Balancer:** `http://localhost:80`
* **Gateway Node 1:** `http://localhost:8080` (Internal)
* **Gateway Node 2:** `http://localhost:8080` (Internal)
* **Gateway Node 3:** `http://localhost:8080` (Internal)
* **Redis 7:** `localhost:6379`
* **Mock Upstream:** `mock-upstream:4000`
* **Prometheus:** `http://localhost:9090`

### Running the k6 Concurrency Torture Test:
```bash
k6 run test/load/burst_test.js
```

### Running Chaos Injection (Redis Failure):
```bash
# Pause Redis to trigger circuit breaker fail-open
docker pause sentinel-redis

# Check circuit breaker status via gateway health endpoint
curl http://localhost/health
# sentinel_circuit_breaker_state transitions to 2 (OPEN)
# Requests continue to be served without 502/500 errors via L1 fallback

# Unpause Redis
docker unpause sentinel-redis
# After 10s recovery window, circuit breaker probes and resumes distributed Redis state
```

---

## License
Apache-2.0
