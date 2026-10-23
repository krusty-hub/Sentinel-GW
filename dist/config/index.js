import fs from 'node:fs';
import yaml from 'js-yaml';
export class ConfigManager {
    config;
    configPath;
    listeners = [];
    constructor(configPath) {
        this.configPath = configPath;
        this.config = this.readConfigFromFile(configPath);
    }
    getConfig() {
        return this.config;
    }
    reload() {
        const newConfig = this.readConfigFromFile(this.configPath);
        this.config = newConfig;
        for (const listener of this.listeners) {
            try {
                listener(newConfig);
            }
            catch (err) {
                console.error('Error in config reload listener:', err);
            }
        }
        return this.config;
    }
    onReload(callback) {
        this.listeners.push(callback);
    }
    readConfigFromFile(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Config file not found at ${filePath}`);
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = yaml.load(raw);
        const server = {
            port: parsed.server?.port ?? 8080,
            node_id: parsed.server?.node_id ?? process.env.GATEWAY_NODE_ID ?? 'gateway-node-1',
            total_nodes: parsed.server?.total_nodes ?? parseInt(process.env.TOTAL_NODES || '1', 10) ?? 1,
            trusted_proxies: parsed.server?.trusted_proxies ?? ['127.0.0.1/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
            upstream_timeout_ms: parsed.server?.upstream_timeout_ms ?? 5000,
        };
        const redis = {
            address: process.env.REDIS_ADDR ?? parsed.redis?.address ?? '127.0.0.1:6379',
            pool_size: parsed.redis?.pool_size ?? 100,
            command_timeout_ms: parsed.redis?.command_timeout_ms ?? 15,
            circuit_breaker: {
                failure_threshold: parsed.redis?.circuit_breaker?.failure_threshold ?? 5,
                recovery_window_ms: parsed.redis?.circuit_breaker?.recovery_window_ms ?? 10000,
            },
        };
        const tiers = parsed.tiers ?? {
            free: { algorithm: 'token_bucket', capacity: 20, refill_rate_per_sec: 1.0 },
            pro: { algorithm: 'token_bucket', capacity: 500, refill_rate_per_sec: 50.0 },
            enterprise: { algorithm: 'token_bucket', capacity: 2000, refill_rate_per_sec: 200.0 },
        };
        const routes = parsed.routes ?? [];
        const api_keys = parsed.api_keys ?? {};
        return {
            server,
            redis,
            tiers,
            api_keys,
            routes,
        };
    }
}
//# sourceMappingURL=index.js.map