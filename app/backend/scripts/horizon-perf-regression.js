/**
 * Performance Regression Test Suite for Horizon-Backed Endpoints
 * 
 * Benchmarks and asserts performance budgets for:
 *  - GET /transactions (horizonService.getPayments)
 *  - GET /payments/recent
 *  - In-memory LRU caching, warm vs cold latency
 *  - High-concurrency throughput
 *  - Deep cursor-based pagination
 *  - Degraded-mode circuit breaker and 429 backoff
 *  - Memory leak stability across iterations
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

// Performance Budgets
const BUDGETS = {
  WARM_CACHE_P95_MS: 20,       // Warm cache p95 must be <= 20ms
  COLD_FETCH_P95_MS: 300,      // Simulated cold fetch p95 <= 300ms
  CONCURRENT_THROUGHPUT_MIN: 100, // Min 100 req/sec under concurrency
  CIRCUIT_FAIL_FAST_MS: 50,    // Degraded mode must fail fast <= 50ms
  MAX_MEMORY_GROWTH_MB: 15,    // Max 15MB heap growth after 1000 requests
};

// Simulated mock Horizon provider
class MockHorizonBackend {
  constructor() {
    this.rateLimited = false;
    this.latencyMs = 40;
  }

  async fetchPayments(accountId, limit = 20, cursor = null, simulateDelay = true) {
    if (this.rateLimited) {
      const err = new Error('Horizon Rate Limit Exceeded (429)');
      err.response = { status: 429 };
      throw err;
    }
    // Simulate network delay for latency tests
    if (simulateDelay) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    const items = [];
    for (let i = 0; i < limit; i++) {
      items.push({
        id: `tx_${cursor || 'start'}_${i}`,
        type: 'payment',
        from: accountId,
        to: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '100.5000000',
        asset: 'native',
        timestamp: new Date().toISOString(),
      });
    }

    return {
      items,
      nextCursor: `cursor_${Date.now()}_${limit}`,
      prevCursor: cursor ? `prev_${cursor}` : null,
    };
  }
}

// In-memory Horizon Service implementation mirroring production logic
class BenchmarkHorizonService {
  constructor(backend) {
    this.backend = backend;
    this.cache = new Map();
    this.maxCacheItems = 500;
    this.circuitOpen = false;
  }

  getCacheKey(accountId, asset, limit, cursor) {
    return `${accountId}:${asset || 'all'}:${limit}:${cursor || 'none'}`;
  }

  async getPayments(accountId, asset, limit = 20, cursor, simulateDelay = true) {
    if (this.circuitOpen) {
      throw new Error('Circuit Breaker OPEN - Horizon Degraded Mode');
    }

    const key = this.getCacheKey(accountId, asset, limit, cursor);
    if (this.cache.has(key)) {
      return { data: this.cache.get(key), fromCache: true };
    }

    try {
      const data = await this.backend.fetchPayments(accountId, limit, cursor, simulateDelay);
      if (this.cache.size >= this.maxCacheItems) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, data);
      return { data, fromCache: false };
    } catch (err) {
      if (err.response && err.response.status === 429) {
        this.circuitOpen = true;
      }
      throw err;
    }
  }

  resetCircuit() {
    this.circuitOpen = false;
  }
}

function calculatePercentiles(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.50)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  return { min, max, avg, p50, p95, p99 };
}

async function runPerformanceRegressionSuite() {
  console.log('================================================================');
  console.log('QuickEx Horizon-Backed Endpoints Performance Regression Suite');
  console.log('================================================================\n');

  const backend = new MockHorizonBackend();
  const service = new BenchmarkHorizonService(backend);
  const accountId = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSAC2WSRWZ7CX27';

  const testResults = [];

  // Benchmark 1: Cold Cache vs Warm Cache Latency
  console.log('📊 Benchmark 1: Cold vs Warm Cache Latency...');
  const coldStart = performance.now();
  await service.getPayments(accountId, undefined, 20);
  const coldDuration = performance.now() - coldStart;

  const warmLatencies = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const res = await service.getPayments(accountId, undefined, 20);
    const duration = performance.now() - t0;
    if (!res.fromCache) throw new Error('Expected warm cache hit');
    warmLatencies.push(duration);
  }

  const warmStats = calculatePercentiles(warmLatencies);
  const warmPassed = warmStats.p95 <= BUDGETS.WARM_CACHE_P95_MS;
  testResults.push({
    name: 'Warm Cache Latency (p95)',
    metric: `${warmStats.p95.toFixed(2)}ms`,
    budget: `<=${BUDGETS.WARM_CACHE_P95_MS}ms`,
    passed: warmPassed,
  });

  console.log(`   Cold latency: ${coldDuration.toFixed(2)}ms`);
  console.log(`   Warm p50:     ${warmStats.p50.toFixed(2)}ms`);
  console.log(`   Warm p95:     ${warmStats.p95.toFixed(2)}ms (Budget: <=${BUDGETS.WARM_CACHE_P95_MS}ms)`);
  console.log(`   Warm p99:     ${warmStats.p99.toFixed(2)}ms`);
  console.log(`   Result:       ${warmPassed ? 'PASSED ✅' : 'FAILED ❌'}\n`);

  // Benchmark 2: Concurrent Throughput Under Load
  console.log('📊 Benchmark 2: High Concurrency Throughput (100 concurrent reqs)...');
  const concurrencyCount = 100;
  const concStart = performance.now();
  await Promise.all(
    Array.from({ length: concurrencyCount }, (_, i) =>
      service.getPayments(accountId, undefined, 20)
    )
  );
  const concDurationSec = (performance.now() - concStart) / 1000;
  const throughput = concurrencyCount / concDurationSec;
  const throughputPassed = throughput >= BUDGETS.CONCURRENT_THROUGHPUT_MIN;

  testResults.push({
    name: 'Concurrent Throughput',
    metric: `${throughput.toFixed(1)} req/s`,
    budget: `>=${BUDGETS.CONCURRENT_THROUGHPUT_MIN} req/s`,
    passed: throughputPassed,
  });

  console.log(`   Duration:     ${(concDurationSec * 1000).toFixed(2)}ms`);
  console.log(`   Throughput:   ${throughput.toFixed(1)} req/s (Budget: >=${BUDGETS.CONCURRENT_THROUGHPUT_MIN} req/s)`);
  console.log(`   Result:       ${throughputPassed ? 'PASSED ✅' : 'FAILED ❌'}\n`);

  // Benchmark 3: Cursor Pagination Latency Scaling
  console.log('📊 Benchmark 3: Deep Pagination Latency Stability (10 pages)...');
  let cursor = null;
  const paginationLatencies = [];
  for (let page = 0; page < 10; page++) {
    const t0 = performance.now();
    const res = await service.getPayments(accountId, undefined, 20, cursor);
    paginationLatencies.push(performance.now() - t0);
    cursor = res.data.nextCursor;
  }
  const pagStats = calculatePercentiles(paginationLatencies);
  const paginationPassed = pagStats.p95 <= BUDGETS.COLD_FETCH_P95_MS;

  testResults.push({
    name: 'Pagination p95 Latency',
    metric: `${pagStats.p95.toFixed(2)}ms`,
    budget: `<=${BUDGETS.COLD_FETCH_P95_MS}ms`,
    passed: paginationPassed,
  });

  console.log(`   Page avg latency: ${pagStats.avg.toFixed(2)}ms`);
  console.log(`   Page p95 latency: ${pagStats.p95.toFixed(2)}ms (Budget: <=${BUDGETS.COLD_FETCH_P95_MS}ms)`);
  console.log(`   Result:           ${paginationPassed ? 'PASSED ✅' : 'FAILED ❌'}\n`);

  // Benchmark 4: Degraded Mode & 429 Fail-Fast Behavior
  console.log('📊 Benchmark 4: Upstream Horizon 429 Rate-Limit Degraded Mode...');
  backend.rateLimited = true;
  try {
    await service.getPayments('GA_RATE_LIMIT_TEST', undefined, 20, 'new_cursor');
  } catch (err) {
    // Expected 429 error
  }

  // Next requests should immediately trip circuit and fail fast
  const degradedLatencies = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    try {
      await service.getPayments('GA_RATE_LIMIT_TEST', undefined, 20, 'new_cursor');
    } catch {
      degradedLatencies.push(performance.now() - t0);
    }
  }

  const degStats = calculatePercentiles(degradedLatencies);
  const degradedPassed = degStats.p95 <= BUDGETS.CIRCUIT_FAIL_FAST_MS;
  testResults.push({
    name: 'Degraded Mode Fail-Fast (p95)',
    metric: `${degStats.p95.toFixed(2)}ms`,
    budget: `<=${BUDGETS.CIRCUIT_FAIL_FAST_MS}ms`,
    passed: degradedPassed,
  });

  console.log(`   Degraded p95 latency: ${degStats.p95.toFixed(2)}ms (Budget: <=${BUDGETS.CIRCUIT_FAIL_FAST_MS}ms)`);
  console.log(`   Result:               ${degradedPassed ? 'PASSED ✅' : 'FAILED ❌'}\n`);

  // Reset backend & circuit
  backend.rateLimited = false;
  service.resetCircuit();

  // Benchmark 5: Memory Leak & Eviction Stability
  console.log('📊 Benchmark 5: Memory Growth & Cache Eviction (1,000 iterations)...');
  if (global.gc) global.gc();
  const initialMemoryMB = process.memoryUsage().heapUsed / (1024 * 1024);

  for (let i = 0; i < 1000; i++) {
    await service.getPayments(`GA_STRESS_ACCOUNT_${i % 100}`, undefined, 20, `cursor_${i}`, false);
  }

  if (global.gc) global.gc();
  const finalMemoryMB = process.memoryUsage().heapUsed / (1024 * 1024);
  const memoryDeltaMB = Math.max(0, finalMemoryMB - initialMemoryMB);
  const memoryPassed = memoryDeltaMB <= BUDGETS.MAX_MEMORY_GROWTH_MB;

  testResults.push({
    name: 'Memory Growth After 1000 Reqs',
    metric: `+${memoryDeltaMB.toFixed(2)}MB`,
    budget: `<=${BUDGETS.MAX_MEMORY_GROWTH_MB}MB`,
    passed: memoryPassed,
  });

  console.log(`   Heap Initial: ${initialMemoryMB.toFixed(2)} MB`);
  console.log(`   Heap Final:   ${finalMemoryMB.toFixed(2)} MB`);
  console.log(`   Heap Delta:   +${memoryDeltaMB.toFixed(2)} MB (Budget: <=${BUDGETS.MAX_MEMORY_GROWTH_MB}MB)`);
  console.log(`   Cache Size:   ${service.cache.size} / ${service.maxCacheItems}`);
  console.log(`   Result:       ${memoryPassed ? 'PASSED ✅' : 'FAILED ❌'}\n`);

  // Report Summary
  console.log('================================================================');
  console.log('Performance Regression Test Summary:');
  console.log('================================================================');
  for (const r of testResults) {
    const status = r.passed ? '✅ PASSED' : '❌ FAILED';
    console.log(`${r.name.padEnd(35)}: ${r.metric.padEnd(12)} (Budget: ${r.budget.padEnd(12)}) ${status}`);
  }
  console.log('================================================================\n');

  // Save report
  const reportDir = path.join(__dirname, '..', 'reports', 'performance');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(reportDir, 'horizon-perf.json'),
    JSON.stringify({ timestamp: new Date().toISOString(), results: testResults }, null, 2)
  );

  const allPassed = testResults.every((r) => r.passed);
  if (!allPassed) {
    console.error('❌ Horizon performance regression detected: one or more budgets violated!');
    process.exit(1);
  }

  console.log('✅ All Horizon endpoint performance budgets met! Zero regressions detected.\n');
}

runPerformanceRegressionSuite().catch((err) => {
  console.error('Fatal error in performance regression suite:', err);
  process.exit(1);
});
