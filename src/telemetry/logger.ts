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

export class StructuredLogger {
  private nodeId: string;

  constructor(nodeId: string) {
    this.nodeId = nodeId;
  }

  public setNodeId(nodeId: string): void {
    this.nodeId = nodeId;
  }

  public logThrottled(event: {
    requestId: string;
    clientId: string;
    routeId: string;
    algorithm: string;
    remaining: number;
    retryAfterMs: number;
    rlEvalLatencyMs: number;
  }): void {
    const payload: ThrottledLogEvent = {
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

  public logCircuitTransition(from: number, to: number): void {
    const stateNames = ['CLOSED', 'HALF_OPEN', 'OPEN'];
    const payload: ThrottledLogEvent = {
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

  public info(message: string, meta?: Record<string, unknown>): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'INFO',
        message,
        gateway_node: this.nodeId,
        ...meta,
      })
    );
  }

  public error(message: string, error?: unknown): void {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'ERROR',
        message,
        gateway_node: this.nodeId,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      })
    );
  }
}
