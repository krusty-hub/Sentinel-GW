export interface Clock {
    now(): number;
}
export declare class SystemClock implements Clock {
    now(): number;
}
export declare class MockClock implements Clock {
    private currentMs;
    constructor(initialMs?: number);
    now(): number;
    advance(ms: number): void;
    set(ms: number): void;
}
