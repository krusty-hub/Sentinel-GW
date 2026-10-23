export interface Clock {
  now(): number; // milliseconds
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class MockClock implements Clock {
  private currentMs: number;

  constructor(initialMs: number = 0) {
    this.currentMs = initialMs;
  }

  now(): number {
    return this.currentMs;
  }

  advance(ms: number): void {
    if (ms < 0) {
      throw new Error('Cannot move mock clock backwards');
    }
    this.currentMs += ms;
  }

  set(ms: number): void {
    this.currentMs = ms;
  }
}
