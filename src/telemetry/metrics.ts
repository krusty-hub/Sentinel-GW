import client from 'prom-client';

export class TelemetryMetrics {
  public readonly register: client.Registry;

  public readonly httpRequestsTotal: client.Counter<'route' | 'method' | 'status' | 'decision'>;
  public readonly ratelimitLatencySeconds: client.Histogram<'backend'>;
  public readonly circuitBreakerState: client.Gauge<string>;
  public readonly upstreamDurationSeconds: client.Histogram<'route'>;

  constructor() {
    this.register = new client.Registry();
    client.collectDefaultMetrics({ register: this.register, prefix: 'sentinel_' });

    this.httpRequestsTotal = new client.Counter({
      name: 'sentinel_http_requests_total',
      help: 'Total number of HTTP requests processed by SentinelGW',
      labelNames: ['route', 'method', 'status', 'decision'],
      registers: [this.register],
    });

    this.ratelimitLatencySeconds = new client.Histogram({
      name: 'sentinel_ratelimit_latency_seconds',
      help: 'Time spent evaluating rate limits in seconds',
      labelNames: ['backend'],
      buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025],
      registers: [this.register],
    });

    this.circuitBreakerState = new client.Gauge({
      name: 'sentinel_circuit_breaker_state',
      help: 'Current state of Redis circuit breaker (0=Closed, 1=Half-Open, 2=Open)',
      registers: [this.register],
    });

    this.upstreamDurationSeconds = new client.Histogram({
      name: 'sentinel_upstream_duration_seconds',
      help: 'Upstream microservice response latency in seconds',
      labelNames: ['route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.register],
    });
  }

  public getMetrics(): Promise<string> {
    return this.register.metrics();
  }
}
