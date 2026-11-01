'use strict';
// A compact "seen before?" index for duplicate checks: 52-bit hashes in an open-addressing
// table of typed arrays (12 bytes a slot) instead of a Map of strings (~60 bytes an entry).
// With 300k rows a false "duplicate" has a chance of about 1 in 100,000.

const crypto = require('crypto');

function hash52(text) {
    const b = crypto.createHash('sha1').update(text).digest();
    // 52 bits: 4 bytes + 20 bits; +1 so that 0 marks an empty slot.
    return b.readUInt32BE(0) * 1048576 + (b.readUInt32BE(4) >>> 12) + 1;
}

class HashIndex {
    constructor(capacity = 1024) {
        this.cap = 1;
        while (this.cap < capacity * 2) this.cap <<= 1;
        this.keys = new Float64Array(this.cap);
        this.vals = new Int32Array(this.cap);
        this.size = 0;
    }

    _slot(h) {
        let i = (h % this.cap) | 0;
        for (;;) {
            const k = this.keys[i];
            if (k === 0 || k === h) return i;
            i = (i + 1) & (this.cap - 1);
        }
    }

    _grow() {
        const oldK = this.keys;
        const oldV = this.vals;
        this.cap <<= 1;
        this.keys = new Float64Array(this.cap);
        this.vals = new Int32Array(this.cap);
        for (let i = 0; i < oldK.length; i++) {
            if (oldK[i] !== 0) {
                const j = this._slot(oldK[i]);
                this.keys[j] = oldK[i];
                this.vals[j] = oldV[i];
            }
        }
    }

    /** Returns the value stored for `text` before (e.g. its first row number), or -1 after storing `value`. */
    firstOrAdd(text, value) {
        const h = hash52(text);
        const i = this._slot(h);
        if (this.keys[i] === h) return this.vals[i];
        this.keys[i] = h;
        this.vals[i] = value;
        this.size++;
        if (this.size * 2 > this.cap) this._grow();
        return -1;
    }
}

module.exports = { HashIndex, hash52 };
