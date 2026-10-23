import client from 'prom-client';
export declare class TelemetryMetrics {
    readonly register: client.Registry;
    readonly httpRequestsTotal: client.Counter<'route' | 'method' | 'status' | 'decision'>;
    readonly ratelimitLatencySeconds: client.Histogram<'backend'>;
    readonly circuitBreakerState: client.Gauge<string>;
    readonly upstreamDurationSeconds: client.Histogram<'route'>;
    constructor();
    getMetrics(): Promise<string>;
}
