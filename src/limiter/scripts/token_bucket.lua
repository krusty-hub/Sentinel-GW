-- KEYS[1]: Rate limit key (e.g., "rl:tb:payments_api:user_123")
-- ARGV[1]: Bucket capacity (B)
-- ARGV[2]: Refill rate per second (R)
-- ARGV[3]: Requested tokens / cost (C)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3]) or 1

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
