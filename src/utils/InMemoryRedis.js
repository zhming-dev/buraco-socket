class InMemoryRedis {
  constructor() {
    this.store = new Map();
    this.expiryTimers = new Map();
  }

  async setex(key, ttlSeconds, value) {
    this._clearExpiry(key);
    this.store.set(key, value);
    if (ttlSeconds > 0) this._armExpiry(key, Date.now() + ttlSeconds * 1000);
    return 'OK';
  }

  /**
   * Deletes `key` at `deadline` (epoch ms). setTimeout caps at 2^31-1 ms
   * (~24.8 days) and fires at once beyond it, so a longer TTL re-arms in steps.
   */
  _armExpiry(key, deadline) {
    const timer = setTimeout(
      () => {
        if (Date.now() < deadline) {
          this._armExpiry(key, deadline);
          return;
        }
        this.store.delete(key);
        this.expiryTimers.delete(key);
      },
      Math.min(Math.max(0, deadline - Date.now()), 2147483647)
    );
    if (typeof timer.unref === 'function') timer.unref();
    this.expiryTimers.set(key, timer);
  }

  /**
   * Minimal `SET key value [NX|XX] [PX ms | EX s]` for room-owner leases
   * (PTW-43). Returns 'OK' on write, or null when an NX/XX condition is not met.
   * Note: a real Redis applies this atomically across nodes; the in-memory store
   * is single-process only and is intended for local dev/tests.
   */
  async set(key, value, ...args) {
    let nx = false;
    let xx = false;
    let ttlMs;
    for (let i = 0; i < args.length; i += 1) {
      const token = String(args[i]).toUpperCase();
      if (token === 'NX') nx = true;
      else if (token === 'XX') xx = true;
      else if (token === 'PX') {
        ttlMs = parseInt(args[i + 1], 10);
        i += 1;
      } else if (token === 'EX') {
        ttlMs = parseInt(args[i + 1], 10) * 1000;
        i += 1;
      }
    }

    const exists = this.store.has(key);
    if (nx && exists) return null;
    if (xx && !exists) return null;

    this._clearExpiry(key);
    this.store.set(key, value);
    if (ttlMs > 0) this._armExpiry(key, Date.now() + ttlMs);
    return 'OK';
  }

  /** Reset the TTL of an existing key. Returns 1 if applied, 0 if missing. */
  async pexpire(key, ttlMs) {
    if (!this.store.has(key)) return 0;
    this._clearExpiry(key);
    if (ttlMs > 0) this._armExpiry(key, Date.now() + ttlMs);
    return 1;
  }

  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  getSync(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async del(key) {
    this._clearExpiry(key);
    const existed = this.store.delete(key);
    return existed ? 1 : 0;
  }

  async exists(key) {
    return this.store.has(key) ? 1 : 0;
  }

  async keys(pattern) {
    const regex = this._patternToRegex(pattern);
    return Array.from(this.store.keys()).filter((key) => regex.test(key));
  }

  async quit() {
    this.expiryTimers.forEach((timer) => clearTimeout(timer));
    this.expiryTimers.clear();
    this.store.clear();
    return 'OK';
  }

  _clearExpiry(key) {
    const timer = this.expiryTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(key);
    }
  }

  _patternToRegex(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }
}

module.exports = InMemoryRedis;
