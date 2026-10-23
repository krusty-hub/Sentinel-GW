export class StructuredLogger {
    nodeId;
    constructor(nodeId) {
        this.nodeId = nodeId;
    }
    setNodeId(nodeId) {
        this.nodeId = nodeId;
    }
    logThrottled(event) {
        const payload = {
            ts: new Date().toISOString(),
            level: 'WARN',
            event: 'request_throttled',
            request_id: event.requestId,
            client_id: event.clientId,
            route_id: event.routeId,
            algorithm: event.algorithm,
            remaining: event.remaining,
            retry_after_ms: event.retryAfterMs,
            rl_eval_latency_ms: Number(event.rlEvalLatencyMs.toFixed(2)),
            gateway_node: this.nodeId,
        };
        console.warn(JSON.stringify(payload));
    }
    logCircuitTransition(from, to) {
        const stateNames = ['CLOSED', 'HALF_OPEN', 'OPEN'];
        const payload = {
            ts: new Date().toISOString(),
            level: to === 2 ? 'WARN' : 'INFO',
            event: 'circuit_breaker_transition',
            gateway_node: this.nodeId,
            details: {
                from: stateNames[from],
                to: stateNames[to],
                state_code: to,
            },
        };
        console.log(JSON.stringify(payload));
    }
    info(message, meta) {
        console.log(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'INFO',
            message,
            gateway_node: this.nodeId,
            ...meta,
        }));
    }
    error(message, error) {
        console.error(JSON.stringify({
            ts: new Date().toISOString(),
            level: 'ERROR',
            message,
            gateway_node: this.nodeId,
            error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
        }));
    }
}
//# sourceMappingURL=logger.js.map