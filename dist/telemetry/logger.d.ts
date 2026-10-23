export interface ThrottledLogEvent {
    ts: string;
    level: 'WARN' | 'INFO' | 'ERROR';
    event: 'request_throttled' | 'circuit_breaker_transition' | 'config_reloaded';
    request_id?: string;
    client_id?: string;
    route_id?: string;
    algorithm?: string;
    remaining?: number;
    retry_after_ms?: number;
    rl_eval_latency_ms?: number;
    gateway_node: string;
    details?: Record<string, unknown>;
}
export declare class StructuredLogger {
    private nodeId;
    constructor(nodeId: string);
    setNodeId(nodeId: string): void;
    logThrottled(event: {
        requestId: string;
        clientId: string;
        routeId: string;
        algorithm: string;
        remaining: number;
        retryAfterMs: number;
        rlEvalLatencyMs: number;
    }): void;
    logCircuitTransition(from: number, to: number): void;
    info(message: string, meta?: Record<string, unknown>): void;
    error(message: string, error?: unknown): void;
}
