import fs from 'node:fs';
import yaml from 'js-yaml';
import { RateLimitPolicy } from '../limiter/types.js';

export interface ServerConfig {
  port: number;
  node_id: string;
  total_nodes: number;
  trusted_proxies: string[];
  upstream_timeout_ms: number;
}

export interface RedisConfig {
  address: string;
  pool_size: number;
  command_timeout_ms: number;
  circuit_breaker: {
    failure_threshold: number;
    recovery_window_ms: number;
  };
}

export interface RouteConfig {
  id: string;
  path_prefix: string;
  methods: string[];
  upstream_url: string;
  identity_source: 'api_key' | 'jwt' | 'ip';
  tier_based?: boolean;
  override_policy?: RateLimitPolicy;
}

export interface GatewayConfig {
  server: ServerConfig;
  redis: RedisConfig;
  tiers: Record<string, RateLimitPolicy>;
  api_keys?: Record<string, { tier: string }>;
  routes: RouteConfig[];
}

export class ConfigManager {
  private config: GatewayConfig;
  private readonly configPath: string;
  private listeners: ((newConfig: GatewayConfig) => void)[] = [];

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = this.readConfigFromFile(configPath);
  }

  public getConfig(): GatewayConfig {
    return this.config;
  }

  public reload(): GatewayConfig {
    const newConfig = this.readConfigFromFile(this.configPath);
    this.config = newConfig;
    for (const listener of this.listeners) {
      try {
        listener(newConfig);
      } catch (err) {
        console.error('Error in config reload listener:', err);
      }
    }
    return this.config;
  }

  public onReload(callback: (newConfig: GatewayConfig) => void): void {
    this.listeners.push(callback);
  }

  private readConfigFromFile(filePath: string): GatewayConfig {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Config file not found at ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = yaml.load(raw) as Partial<GatewayConfig>;

    const server: ServerConfig = {
      port: parsed.server?.port ?? 8080,
      node_id: parsed.server?.node_id ?? process.env.GATEWAY_NODE_ID ?? 'gateway-node-1',
      total_nodes: parsed.server?.total_nodes ?? parseInt(process.env.TOTAL_NODES || '1', 10) ?? 1,
      trusted_proxies: parsed.server?.trusted_proxies ?? ['127.0.0.1/32', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'],
      upstream_timeout_ms: parsed.server?.upstream_timeout_ms ?? 5000,
    };

    const redis: RedisConfig = {
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
