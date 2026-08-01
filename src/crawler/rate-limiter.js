/**
 * Token-Bucket Rate Limiter für respektvolles Crawling.
 * Erlaubt maxRequests pro Verbrauchsfenster (Standard: 60 Sekunden).
 */
export class RateLimiter {
  constructor(maxRequests = 40, windowMs = 60000) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refillRate = this.maxRequests / this.windowMs;
    this.tokens = Math.min(this.maxRequests, this.tokens + elapsed * refillRate);
    this.lastRefill = now;
  }

  /**
   * Wartet, bis ein Request-Slot frei ist.
   */
  async acquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil(((1 - this.tokens) * this.windowMs) / this.maxRequests);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this._refill();
    this.tokens -= 1;
  }
}

/**
 * Verteilte Rate-Limiter-Verwaltung (ein Limiter pro Portal)
 */
export class RateLimiterRegistry {
  constructor(globalLimiter = null) {
    this.limiters = new Map();
    this.globalLimiter = globalLimiter;
  }

  for(sourceId, maxRequests, windowMs) {
    const key = `${sourceId}:${maxRequests}:${windowMs}`;
    if (!this.limiters.has(key)) {
      this.limiters.set(key, new RateLimiter(maxRequests, windowMs));
    }
    return this.limiters.get(key);
  }

  /**
   * Wartet, bis globaler + portal-spezifischer Slot frei sind.
   */
  async acquire(sourceId, maxRequests, windowMs) {
    if (this.globalLimiter) await this.globalLimiter.acquire();
    const limiter = this.for(sourceId, maxRequests, windowMs);
    await limiter.acquire();
  }
}