-- KEYS[1]: Rate limit key (e.g., "rl:lb:webhooks:client_123")
-- ARGV[1]: Bucket capacity / burst limit (B)
-- ARGV[2]: Leak rate per second (R)
-- ARGV[3]: Requested capacity / cost (C)

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local leak_rate = tonumber(ARGV[2])
local requested = tonumber(ARGV[3]) or 1

-- 1. Canonical time from Redis
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)

-- 2. Read current water level
local data = redis.call('HMGET', key, 'water', 'last_leak_ms')
local water = tonumber(data[1])
local last_leak_ms = tonumber(data[2])

if water == nil then
    water = 0
    last_leak_ms = now_ms
else
    local elapsed_sec = math.max(0, now_ms - last_leak_ms) / 1000.0
    water = math.max(0, water - (elapsed_sec * leak_rate))
    last_leak_ms = now_ms
end

-- 3. Evaluate admission
local allowed = 0
local retry_after_ms = 0

if (water + requested) <= capacity then
    allowed = 1
    water = water + requested
else
    allowed = 0
    retry_after_ms = math.ceil(((water + requested - capacity) / leak_rate) * 1000)
end

-- 4. Persist and expire
redis.call('HSET', key, 'water', water, 'last_leak_ms', last_leak_ms)
local drain_time_ms = math.ceil((water / leak_rate) * 1000)
local ttl_ms = math.max(1000, drain_time_ms + 1000)
redis.call('PEXPIRE', key, ttl_ms)

local reset_epoch_sec = math.ceil((now_ms + drain_time_ms) / 1000)
local remaining = math.max(0, math.floor(capacity - water))

return { allowed, remaining, retry_after_ms, reset_epoch_sec }
