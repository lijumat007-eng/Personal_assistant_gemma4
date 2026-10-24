'use strict';
// Native mouse capture is a short lease, never a permanently cached renderer flag.
class PointerLease {
    constructor(timeout = 350) { this.timeout = timeout; this.sequence = 0; this.pending = new Map(); this.last = null; }
    request(point, bounds, now) {
        const token = ++this.sequence;
        this.pending.set(token, { point: { ...point }, bounds: { ...bounds }, at: now });
        for (const [id, sample] of this.pending) if (now - sample.at >= this.timeout) this.pending.delete(id);
        return token;
    }
    reply(token, hit, now) {
        const sample = this.pending.get(token); this.pending.delete(token);
        if (!sample || typeof hit !== 'boolean' || now - sample.at >= this.timeout || token <= (this.last?.token || 0)) return false;
        this.last = { ...sample, token, hit }; return true;
    }
    fresh(now) { return !!this.last && now - this.last.at < this.timeout; }
    captures(point, bounds, now) {
        const last = this.last;
        return this.fresh(now) && last.hit && Math.abs(last.point.x - point.x) <= 2 && Math.abs(last.point.y - point.y) <= 2 &&
            ['x', 'y', 'width', 'height'].every(key => last.bounds[key] === bounds[key]);
    }
    clear() { this.pending.clear(); this.last = null; }
}
module.exports = { PointerLease };
