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
