export class SystemClock {
    now() {
        return Date.now();
    }
}
export class MockClock {
    currentMs;
    constructor(initialMs = 0) {
        this.currentMs = initialMs;
    }
    now() {
        return this.currentMs;
    }
    advance(ms) {
        if (ms < 0) {
            throw new Error('Cannot move mock clock backwards');
        }
        this.currentMs += ms;
    }
    set(ms) {
        this.currentMs = ms;
    }
}
//# sourceMappingURL=clock.js.map