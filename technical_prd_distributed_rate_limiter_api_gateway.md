# Technical Product Requirements Document (PRD)
## Project: Distributed Rate Limiter & API Gateway ("SentinelGW")

| Metadata | Details |
| :--- | :--- |
| **Document Status** | Approved for Implementation |
| **Version** | 1.0.0 |
| **Target Architecture** | Clustered Stateless Middleware + Distributed Redis State |
| **Primary Stack Options** | Go (`net/http/httputil` + `go-redis`) OR Node.js/TypeScript (`Fastify` + `ioredis`) OR Rust (`Axum` + `fred`) |
| **Infrastructure** | Docker Compose, Nginx (L7 Load Balancer), Redis 7+, Prometheus & Grafana |

---

## 1. Executive Summary & Problem Statement

### 1.1 Problem Statement
Modern backend microservices are vulnerable to cascading failures caused by noisy neighbors, credential-stuffing bots, buggy client retry loops, and traffic spikes. While single-node in-memory rate limiters are trivial to implement, they fail in horizontally scaled environments where requests from a single client are load-balanced across $N$ stateless gateway instances. Furthermore, naive distributed implementations using standard Redis `GET` and `SET` operations suffer from **check-then-act race conditions**, **multi-node clock skew**, and **excessive network round-trip latency**.

### 1.2 Product Vision
Build a high-throughput, horizontally scalable **API Gateway and Distributed Rate Limiting Middleware** that sits in front of upstream microservices. It enforces fine-grained traffic policies per user, API key, or IP address across clustered gateway nodes with **zero race-condition drift**, sub-5ms $P_{99}$ latency overhead, and graceful degradation if the backing cache cluster fails.

### 1.3 Goals & Success Metrics (SLOs)
* **Strict Distributed Accuracy:** Under concurrent burst load of $1,000\text{ RPS}$ across $3+$ gateway nodes for a single identity, over-admission drift must be exactly $0\%$.
* **Low Latency Overhead:** Rate-limiter middleware execution (including Redis network round-trip) must achieve $P_{50} \le 1.5\text{ ms}$ and $P_{99} \le 5.0\text{ ms}$.
* **High Availability (Fail-Open / L1 Fallback):** If the Redis cluster becomes unreachable or latency exceeds $15\text{ ms}$, the gateway must automatically trip a circuit breaker and degrade to a local in-memory rate limiter with $0\%$ dropped legitimate upstream traffic.
* **Throughput:** Support at least $5,000\text{ RPS}$ on a local 3-node Docker Compose cluster.

### 1.4 Non-Goals (Out of Scope for v1)
* Full OAuth2/OIDC Identity Provider (IdP) token issuance (the gateway will only *validate* existing API keys or JWT claims).
* Deep GraphQL query-complexity parsing or payload body inspection.
* Multi-region active-active Redis CRDT replication (v1 targets a single-region Redis Primary/Replica or Redis Cluster setup).
* GUI Admin Dashboard (configuration will be managed via declarative YAML and a REST control endpoint).

---

## 2. System Architecture & Request Topology

### 2.1 High-Level Architecture Diagram

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

### 2.2 End-to-End Request Lifecycle
1. **Ingress:** Client sends an HTTP request to the Gateway cluster.
2. **Route Resolution:** Gateway matches the request path and HTTP method against the loaded routing table. If no route matches, return `404 Not Found`.
3. **Identity Extraction:** Middleware extracts the client's unique identifier based on the route's policy hierarchy:
   * Priority 1: `X-API-Key` header (mapped to a customer tier: `free`, `pro`, `enterprise`).
   * Priority 2: `Authorization: Bearer <JWT>` (`sub` claim extracted).
   * Priority 3: Client IP address extracted safely from `X-Forwarded-For` (parsing the rightmost untrusted IP based on configured `trusted_proxies` CIDR list) or socket `RemoteAddr`.
4. **Policy Lookup:** Middleware selects the applicable rate-limit algorithm (`token_bucket`, `sliding_window_counter`, or `leaky_bucket`), capacity, and window/refill parameters.
5. **Distributed State Evaluation:**
   * If the Redis Circuit Breaker is **CLOSED**, the gateway executes a pre-loaded Redis Lua script via `EVALSHA` with a hard timeout of $15\text{ ms}$.
   * If the Redis Circuit Breaker is **OPEN** (or the call times out), the gateway evaluates the request against its **Local In-Memory L1 Fallback Limiter** (configured at $\text{Capacity}_{\text{local}} = \lceil \text{Capacity}_{\text{global}} / N_{\text{nodes}} \rceil$).
6. **Header Injection & Decision:**
   * The gateway attaches `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Policy` headers to the response context.
   * **Allowed ($1$):** Request is forwarded to the upstream service via an HTTP reverse proxy with connection pooling.
   * **Throttled ($0$):** Request is short-circuited immediately with `HTTP 429 Too Many Requests`, a `Retry-After` header (in seconds), and a structured JSON error payload.

---

## 3. Functional Requirements (FRs)

### FR-1: Declarative Configuration & Route Matching
The gateway must load its routing and rate-limiting rules from a declarative `config.yaml` file on startup and support live reloading via `SIGHUP` or `POST /admin/reload`.

```yaml
server:
  port: 8080
  trusted_proxies:
    - "10.0.0.0/8"
    - "172.16.0.0/12"
  upstream_timeout_ms: 5000

redis:
  address: "redis:6379"
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

routes:
  - id: "auth_login"
    path_prefix: "/api/v1/auth/login"
    methods: ["POST"]
    upstream_url: "http://auth-service:4000"
    identity_source: "ip"
    override_policy:
      algorithm: "sliding_window_counter"
      limit: 5
      window_seconds: 60

  - id: "payments_api"
    path_prefix: "/api/v1/payments"
    methods: ["POST", "GET"]
    upstream_url: "http://payment-service:4001"
    identity_source: "api_key"
    tier_based: true

  - id: "webhook_ingest"
    path_prefix: "/api/v1/webhooks"
    methods: ["POST"]
    upstream_url: "http://webhook-worker:4002"
    identity_source: "api_key"
    override_policy:
      algorithm: "leaky_bucket"
      capacity: 50
      leak_rate_per_sec: 10.0
```

### FR-2: Multi-Algorithm Rate Limiting Engine
The system must implement three distinct algorithms selectable per route or tier:
1. **Token Bucket:** Best for general APIs; permits traffic bursts up to bucket capacity $B$ while enforcing sustained average rate $R$. Supports configurable request cost $C \ge 1$ (default $C = 1$).
2. **Sliding Window Counter:** Best for strict security endpoints (e.g., `/login`, `/otp`); prevents the $2\times$ boundary burst flaw of fixed windows while consuming $O(1)$ Redis memory (2 keys per active window).
3. **Leaky Bucket (Metered Queue Mode):** Best for protecting fragile downstream services; smooths bursty traffic by tracking water level $W$ that drains at constant rate $R$.

### FR-3: Standard HTTP Response Headers & Error Contract
Every proxied or rejected response must include:

| Header Name | Description | Example |
| :--- | :--- | :--- |
| `X-RateLimit-Limit` | Maximum requests allowed in the policy capacity/window. | `100` |
| `X-RateLimit-Remaining` | Remaining requests/tokens currently available. | `42` |
| `X-RateLimit-Reset` | Unix epoch timestamp (seconds) when the bucket/window fully resets. | `1792763520` |
| `X-RateLimit-Policy` | Descriptive string of the active policy. | `100;w=60;alg=token_bucket` |
| `Retry-After` | *(Only on HTTP 429)* Seconds until at least 1 request will be permitted. | `3` |

**HTTP 429 JSON Response Body Contract:**
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

## 4. Deep-Dive Technical Specifications & Redis Lua Scripts

### 4.1 Eliminating Clock Skew with Redis `TIME`
Distributed gateway nodes running on different VMs or containers experience NTP clock drift (often $5\text{ ms}$ to $250\text{ ms}$). Passing the application server's local timestamp into Redis causes erroneous token refills or negative elapsed times when consecutive requests hit different gateway nodes.
* **Mandatory Requirement:** Every Lua script **must** invoke `redis.call('TIME')` as its first operation. Redis returns `{seconds, microseconds}`, which is converted inside Lua to milliseconds:

$$T_{\text{now\_ms}} = \left(\text{tonumber}(\text{time}[1]) \times 1000\right) + \lfloor \text{tonumber}(\text{time}[2]) / 1000 \rfloor$$

### 4.2 Algorithm 1: Distributed Token Bucket (Lua Specification)

* **Redis Key Format:** `rl:tb:{route_id}:{client_id}` (Redis Hash)
* **Hash Fields:** `tokens` (float), `last_refill_ms` (integer)
* **Governing Equations:**
  Let $B$ be bucket capacity, $R$ be refill rate (tokens per second), $C$ be request cost, and $\Delta t = \max(0, T_{\text{now\_ms}} - T_{\text{last\_refill\_ms}}) / 1000.0$:

  $$\text{tokens}_{\text{available}} = \min\left(B,\; \text{tokens}_{\text{stored}} + \Delta t \cdot R\right)$$

  If $\text{tokens}_{\text{available}} \ge C$:
  $$\text{allowed} = 1, \quad \text{tokens}_{\text{new}} = \text{tokens}_{\text{available}} - C, \quad \text{retry\_after\_ms} = 0$$
  Else:
  $$\text{allowed} = 0, \quad \text{tokens}_{\text{new}} = \text{tokens}_{\text{available}}, \quad \text{retry\_after\_ms} = \left\lceil \frac{C - \text{tokens}_{\text{available}}}{R} \times 1000 \right\rceil$$

  The key TTL is dynamically set to the time required to refill the bucket completely to prevent stale keys from leaking RAM:
  $$\text{TTL}_{\text{ms}} = \left\lceil \frac{B - \text{tokens}_{\text{new}}}{R} \times 1000 \right\rceil + 1000$$

* **Exact Lua Script (`token_bucket.lua`):**
```lua
-- KEYS[1]: Rate limit key (e.g., "rl:tb:payments_api:user_123")
-- ARGV[1]: Bucket capacity (B)
-- ARGV[2]: Refill rate per second (R)
-- ARGV[3]: Requested tokens / cost (C)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3])

-- 1. Fetch canonical time from Redis to avoid multi-node clock drift
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)

-- 2. Read current bucket state
local data = redis.call('HMGET', key, 'tokens', 'last_refill_ms')
local tokens = tonumber(data[1])
local last_refill_ms = tonumber(data[2])

if tokens == nil then
    tokens = capacity
    last_refill_ms = now_ms
else
    local elapsed_sec = math.max(0, now_ms - last_refill_ms) / 1000.0
    tokens = math.min(capacity, tokens + (elapsed_sec * refill_rate))
    last_refill_ms = now_ms
end

-- 3. Evaluate admission and update state
local allowed = 0
local retry_after_ms = 0

if tokens >= requested then
    allowed = 1
    tokens = tokens - requested
else
    allowed = 0
    retry_after_ms = math.ceil(((requested - tokens) / refill_rate) * 1000)
end

-- 4. Persist state and set automatic expiration (TTL)
redis.call('HSET', key, 'tokens', tokens, 'last_refill_ms', last_refill_ms)
local fill_time_ms = math.ceil(((capacity - tokens) / refill_rate) * 1000)
local ttl_ms = math.max(1000, fill_time_ms + 1000)
redis.call('PEXPIRE', key, ttl_ms)

local reset_epoch_sec = math.ceil((now_ms + fill_time_ms) / 1000)

-- Return: { allowed (1/0), remaining_tokens (int), retry_after_ms (int), reset_epoch_sec (int) }
return { allowed, math.floor(tokens), retry_after_ms, reset_epoch_sec }
```

### 4.3 Algorithm 2: Distributed Sliding Window Counter (Lua Specification)

* **Redis Key Format:**
  * Current window key: `rl:swc:{route_id}:{client_id}:{current_window_id}`
  * Previous window key: `rl:swc:{route_id}:{client_id}:{prev_window_id}`
* **Governing Equations:**
  Let window size be $W_{\text{ms}} = W_{\text{sec}} \times 1000$, and limit be $L$.
  $$\text{current\_window\_id} = \lfloor T_{\text{now\_ms}} / W_{\text{ms}} \rfloor$$
  $$\text{elapsed\_ratio} = \frac{T_{\text{now\_ms}} \bmod W_{\text{ms}}}{W_{\text{ms}}}$$
  $$\text{estimated\_count} = \left\lfloor C_{\text{prev}} \times (1 - \text{elapsed\_ratio}) \right\rfloor + C_{\text{curr}}$$
  If $\text{estimated\_count} < L$, increment $C_{\text{curr}}$ by $1$ and set `PEXPIRE` on the current window key to $2 \times W_{\text{ms}}$.

* **Exact Lua Script (`sliding_window_counter.lua`):**
```lua
-- KEYS[1]: Key prefix (e.g., "rl:swc:auth_login:192.168.1.10")
-- ARGV[1]: Max requests per window (L)
-- ARGV[2]: Window size in milliseconds (W_ms)

local prefix = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)

local current_window = math.floor(now_ms / window_ms)
local prev_window = current_window - 1

local curr_key = prefix .. ":" .. tostring(current_window)
local prev_key = prefix .. ":" .. tostring(prev_window)

local curr_count = tonumber(redis.call('GET', curr_key) or "0")
local prev_count = tonumber(redis.call('GET', prev_key) or "0")

local elapsed_in_window = now_ms % window_ms
local weight = (window_ms - elapsed_in_window) / window_ms
local estimated_count = math.floor(prev_count * weight) + curr_count

local allowed = 0
local retry_after_ms = 0

if estimated_count < limit then
    allowed = 1
    curr_count = redis.call('INCR', curr_key)
    if curr_count == 1 then
        redis.call('PEXPIRE', curr_key, window_ms * 2)
    end
    estimated_count = estimated_count + 1
else
    allowed = 0
    retry_after_ms = window_ms - elapsed_in_window
end

local remaining = math.max(0, limit - estimated_count)
local reset_epoch_sec = math.ceil(((current_window + 1) * window_ms) / 1000)

return { allowed, remaining, retry_after_ms, reset_epoch_sec }
```

---

## 5. Resilience, Fault Tolerance & Degraded Modes

### 5.1 Redis Script Caching (`SCRIPT LOAD` & `EVALSHA`)
Sending a 40-line Lua script string over the network on every HTTP request wastes bandwidth.
1. On gateway startup, compute the SHA1 digest of each Lua script and call `SCRIPT LOAD`.
2. On every request, invoke `EVALSHA <sha1>`.
3. If Redis restarts and flushes its script cache (returning a `NOSCRIPT` error), the gateway middleware must automatically catch `NOSCRIPT`, fall back to `EVAL`, and re-cache the script transparently.

### 5.2 Redis Circuit Breaker & L1 In-Memory Fallback
A distributed rate limiter must never become a Single Point of Failure (SPOF) that takes down the entire API ecosystem when Redis experiences a network partition.

```
         [CLOSED] (Normal Operation: Redis EVALSHA)
             |
             | (5 consecutive Redis timeouts > 15ms or connection errors)
             v
          [OPEN]  (Bypass Redis -> Route to Local L1 In-Memory Token Bucket)
             |
             | (After 10s recovery window expires)
             v
       [HALF-OPEN] (Send 1 probe request to Redis; if < 15ms -> CLOSED, else -> OPEN)
```

* **L1 Fallback Memory Management:** Each gateway node maintains an in-memory sharded hash map (or LRU cache capped at $50,000$ entries with a background $60\text{ s}$ janitor sweep) to enforce local rate limits while the circuit breaker is `OPEN`.

---

## 6. Observability & Telemetry Requirements

### 6.1 Prometheus Metrics Endpoint (`GET /metrics`)
The gateway must expose the following metrics:
* `sentinel_http_requests_total{route, method, status, decision}` (Counter) — where `decision` is `allowed`, `throttled`, or `fallback_allowed`.
* `sentinel_ratelimit_latency_seconds{backend}` (Histogram) — time spent evaluating rate limits (`backend="redis"` vs `backend="local_l1"`), with buckets `[0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025]`.
* `sentinel_circuit_breaker_state` (Gauge) — `0` = Closed, `1` = Half-Open, `2` = Open.
* `sentinel_upstream_duration_seconds{route}` (Histogram) — upstream microservice response latency.

### 6.2 Structured Logging
Every throttled request (`429`) and circuit-breaker state transition must emit a structured JSON log line:
```json
{
  "ts": "2026-10-23T13:51:00.124Z",
  "level": "WARN",
  "event": "request_throttled",
  "request_id": "req_9f8c7b6a5d4e",
  "client_id": "apikey_pro_8821",
  "route_id": "payments_api",
  "algorithm": "token_bucket",
  "remaining": 0,
  "retry_after_ms": 420,
  "rl_eval_latency_ms": 0.84,
  "gateway_node": "gateway-node-2"
}
```

---

## 7. Verification, Load Testing & Acceptance Criteria

To consider the project complete, the system must pass three automated test suites:

### 7.1 Test Suite 1: Deterministic Unit Tests (Mock Clock)
* **Burst Depletion:** Configure Token Bucket with $B = 5, R = 1$. Fire 5 requests at $t = 0\text{ ms}$; assert all 5 return `allowed = 1` and `remaining` decrements $4 \to 0$. Fire 6th request at $t = 100\text{ ms}$; assert `allowed = 0` and `retry_after_ms = 900`.
* **Partial Lazy Refill:** Advance clock to $t = 2500\text{ ms}$. Fire 1 request; assert lazy refill calculates $\min(5, 0 + 2.5 \times 1) = 2.5$ tokens, consumes $1$, returns `allowed = 1` and `remaining = 1` ($\lfloor 1.5 \rfloor$).
* **Sliding Window Boundary Test:** Configure Sliding Window Counter with $L = 10, W = 60\text{ s}$. Fire 10 requests at $t = 59\text{ s}$ of Window 0. Advance clock to $t = 61\text{ s}$ ($1\text{ s}$ into Window 1). Verify that the weighted count from Window 0 ($\lfloor 10 \times (59/60) \rfloor = 9$) permits **only 1** additional request at $t = 61\text{ s}$, preventing the fixed-window $2\times$ boundary exploit.

### 7.2 Test Suite 2: Multi-Node Concurrency Torture Test (k6 / Vegeta)
* **Setup:** Spin up Docker Compose with **1 Nginx Load Balancer**, **3 Gateway Nodes**, **1 Redis instance**, and **1 Mock Upstream**.
* **Scenario:** Configure route `/api/v1/payments` with Token Bucket $B = 100, R = 1\text{ req/s}$. Use `k6` to fire $500$ concurrent requests within $50\text{ ms}$ using a single `X-API-Key` distributed round-robin across all 3 gateway nodes.
* **Acceptance Criterion:**
  * Exactly $100$ requests return `HTTP 200 OK` (or $101$ if elapsed test duration exceeds $1000\text{ ms}$).
  * Exactly $400$ requests return `HTTP 429 Too Many Requests`.
  * Zero `500 Internal Server Error` responses.

### 7.3 Test Suite 3: Chaos & Fault Injection Test
* **Scenario:** While running a sustained $200\text{ RPS}$ load test through the cluster, execute `docker pause redis`.
* **Acceptance Criterion:**
  * Within $15\text{ ms} \times 5 = 75\text{ ms}$, all 3 gateway nodes trip their circuit breakers to `OPEN` (`sentinel_circuit_breaker_state == 2`).
  * Requests continue to be served via the L1 In-Memory fallback limiter without throwing `502`/`500` errors.
  * Execute `docker unpause redis`. After the $10\text{ s}$ recovery window, circuit breakers transition to `HALF-OPEN` and then `CLOSED`, seamlessly resuming distributed enforcement.

---

## 8. Recommended Repository Structure & Implementation Milestones

### 8.1 Project Directory Layout (Language-Agnostic Blueprint)
```
sentinel-gateway/
├── cmd/gateway/              # Application entrypoint & graceful shutdown
├── config/
│   └── config.yaml           # Declarative routes, tiers, and Redis config
├── internal/
│   ├── config/               # YAML parser, validation, & SIGHUP hot-reload
│   ├── proxy/                # Reverse proxy handler & upstream pool
│   ├── middleware/           # Identity extractor, headers, & rate-limit hook
│   ├── limiter/
│   │   ├── interface.go      # RateLimiter interface: Allow(ctx, key, policy)
│   │   ├── redis_limiter.go  # EVALSHA execution & NOSCRIPT recovery
│   │   ├── memory_limiter.go # L1 local fallback limiter + TTL janitor
│   │   ├── circuit.go        # Lock-free atomic circuit breaker
│   │   └── scripts/
│   │       ├── token_bucket.lua
│   │       ├── sliding_window.lua
│   │       └── leaky_bucket.lua
│   └── telemetry/            # Prometheus metrics & structured logger
├── test/
│   ├── mock_upstream/        # Lightweight server returning 200 OK + hostname
│   └── load/
│       └── burst_test.js     # k6 distributed concurrency test script
├── deploy/
│   ├── nginx.conf            # Load balancer configuration
│   └── prometheus.yml        # Metrics scrape configuration
└── docker-compose.yml        # 3x Gateway, 1x Nginx, 1x Redis, 1x Upstream, 1x Prometheus
```

### 8.2 Phased Implementation Milestones
* **Milestone 1 (Days 1–2): Core Reverse Proxy & Identity Extraction**
  * Scaffold the HTTP server, YAML config loader, and reverse proxy forwarding to the mock upstream.
  * Implement identity extraction (`X-API-Key`, JWT `sub`, and safe `X-Forwarded-For` IP parsing) plus structured logging.
* **Milestone 2 (Days 3–4): Local L1 Token Bucket & Unit Tests**
  * Define the `Limiter` interface and build the thread-safe in-memory Token Bucket with an injectable `Clock` interface.
  * Wire up standard `X-RateLimit-*` and `Retry-After` response headers.
* **Milestone 3 (Days 5–7): Redis Lua Engine (Token Bucket & Sliding Window)**
  * Write `token_bucket.lua` and `sliding_window_counter.lua` using `redis.call('TIME')`.
  * Implement script pre-loading (`SCRIPT LOAD`), `EVALSHA` execution, and automatic `NOSCRIPT` fallback.
* **Milestone 4 (Days 8–9): Circuit Breaker & Degraded Failover**
  * Wrap the Redis limiter in the state-machine circuit breaker with a strict $15\text{ ms}$ context timeout that falls back to the Milestone 2 in-memory limiter.
* **Milestone 5 (Days 10–12): Clustering, Prometheus Telemetry & Load Testing**
  * Build the multi-node `docker-compose.yml` with Nginx load balancing.
  * Expose `/metrics` for Prometheus, run the `k6` concurrency torture test and `docker pause redis` chaos test, and document benchmark results in the project `README.md`.