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
    api_keys?: Record<string, {
        tier: string;
    }>;
    routes: RouteConfig[];
}
export declare class ConfigManager {
    private config;
    private readonly configPath;
    private listeners;
    constructor(configPath: string);
    getConfig(): GatewayConfig;
    reload(): GatewayConfig;
    onReload(callback: (newConfig: GatewayConfig) => void): void;
    private readConfigFromFile;
}
