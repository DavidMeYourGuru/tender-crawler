import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, RateLimiterRegistry } from '../src/crawler/rate-limiter.js';
import { sleep } from '../src/utils.js';

test('RateLimiter erlaubt sofortige Requests innerhalb des Limits', async () => {
  const limiter = new RateLimiter(5, 60000);
  for (let i = 0; i < 5; i += 1) {
    await limiter.acquire();
  }
  // Kein Fehler = alle 5 Slots sofort vergeben
});

test('RateLimiter blockiert nach Erreichen des Limits', async () => {
  // 1 Token pro 200ms: Der zweite Request muss warten
  const limiter = new RateLimiter(1, 200);
  await limiter.acquire();
  const started = Date.now();
  await limiter.acquire();
  assert.ok(Date.now() - started >= 150);
});

test('RateLimiter refillt über die Zeit', async () => {
  // 2 Requests pro Sekunde
  const limiter = new RateLimiter(2, 1000);
  await limiter.acquire();
  await limiter.acquire();
  const started = Date.now();
  await limiter.acquire(); // muss warten bis ein Token refilled ist
  const waited = Date.now() - started;
  assert.ok(waited >= 400, `wartete nur ${waited}ms`);
});

test('RateLimiterRegistry vergibt einen Limiter pro Schlüssel', () => {
  const registry = new RateLimiterRegistry();
  const a = registry.for('ted', 10, 60000);
  const b = registry.for('ted', 10, 60000);
  assert.equal(a, b);
  const c = registry.for('bund', 10, 60000);
  assert.notEqual(a, c);
});

test('RateLimiterRegistry akzeptiert globalen Limiter', async () => {
  const globalLimiter = new RateLimiter(3, 300);
  const registry = new RateLimiterRegistry(globalLimiter);
  const limiter = registry.for('ted', 5, 60000);
  const start = Date.now();
  await Promise.all([
    registry.acquire('ted', 5, 60000),
    registry.acquire('ted', 5, 60000),
    registry.acquire('ted', 5, 60000),
    registry.acquire('ted', 5, 60000),
  ]);
  // Der 4. Request muss auf den globalen Limiter warten (refill nach ~100ms)
  assert.ok(Date.now() - start >= 80);
  assert.equal(limiter, registry.for('ted', 5, 60000));
});

test('RateLimiter bleibt unter dem erlaubten Maximum', async () => {
  const max = 5;
  const limiter = new RateLimiter(max, 100);
  let granted = 0;
  for (let i = 0; i < max; i += 1) {
    await limiter.acquire();
    granted += 1;
  }
  assert.equal(granted, max);
});

test('sleep wartet mindestens die angegebene Zeit', async () => {
  const start = Date.now();
  await sleep(50);
  assert.ok(Date.now() - start >= 40);
});
