import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createPricingCatalog, pricesBookOf, priceResolutionOf, priceMessage,
  createPricingAccumulator, isBeijingPeak, normalizeSourceIdentity,
} from '../pricing.js'

const M = 1_000_000
const at = (text) => Date.parse(text)
const off = at('2026-11-13T12:00:00+08:00')
const peak = at('2026-11-13T09:00:00+08:00')
const rate = (input = 0.15, output = 0.6, cacheRead = 0.003) => ({ input, output, cache_read: cacheRead })
const catalogBody = () => ({
  deepseek: { models: { 'deepseek-v4-flash': { cost: rate(), canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017' } } },
  workbuddy: { models: { 'deepseek-v4.1-flash': { cost: rate(99, 99, 99) } } },
  'opencode-go': { models: { 'deepseek-v4.1-flash': { cost: rate(1, 4, 0.1), canonical_model_id: 'deepseek/deepseek-v4.1-flash-1017' } } },
  openai: { models: { 'gpt-example': { cost: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 }, canonical_model_id: 'openai/gpt-example' } } },
})
const snapshot = (raw = catalogBody()) => ({ book: pricesBookOf(raw), source: 'https://models.dev/api.json', version: 1, fetchedAt: 100, stale: false })
const message = (extras = {}) => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', time: off, input: M, cacheRead: M, cacheWrite: M, output: M, ...extras })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
const nearBreakdown = (actual, expected) => { for (const field of Object.keys(expected)) near(actual[field], expected[field]) }
const response = (body = catalogBody()) => ({ ok: true, status: 200, json: async () => body })

test('four distinct token rates, input cache fallback, and reasoning is not double charged', () => {
  const priced = priceMessage(message({ reasoning: 30 * M }), snapshot())
  assert.equal(priced.priced, true)
  assert.deepEqual(priced.breakdown, { input: 0.15, cacheRead: 0.003, cacheWrite: 0.15, output: 0.6 })
  const sum = createPricingAccumulator(snapshot()); sum.add(message())
  near(sum.result().totalUsd, 0.903)
  const openai = priceMessage(message({ provider: 'codex', model: 'gpt-example' }), snapshot())
  nearBreakdown(openai.breakdown, { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 })
})

test('WorkBuddy uses the requested official Flash override even if its own branch lists another price', () => {
  for (const [provider, model] of [
    ['workbuddy', 'deepseek-v4.1-flash'],
    ['workbuddy', 'workbuddy/deepseek-v4.1-flash'],
    ['workbuddy', 'WORKBUDDY/DeepSeek-V4.1-Flash'],
    ['magpie', 'workbuddy/deepseek-v4.1-flash'],
    ['magpie', 'WORKBUDDY/DeepSeek-V4.1-Flash'],
  ]) {
    const actual = priceMessage(message({ provider, model, time: peak }), snapshot())
    assert.equal(actual.face.via, 'user-override')
    assert.equal(actual.face.pid, 'deepseek')
    assert.equal(actual.face.mid, 'deepseek-v4-flash')
    assert.equal(actual.peakPolicy, 'deepseek-official')
    assert.equal(actual.multiplier, 2)
    near(actual.breakdown.input, 0.3)
  }
  assert.notEqual(priceResolutionOf(snapshot().book, 'workbuddy', 'deepseek-v4.2-flash').kind, 'priced')
  assert.notEqual(priceResolutionOf(snapshot().book, 'magpie', 'workbuddy/deepseek-v4.2-flash').kind, 'priced')
  assert.notEqual(priceResolutionOf(snapshot().book, 'magpie', 'deepseek-v4.1-flash').face?.via, 'user-override')
  assert.notEqual(priceResolutionOf(snapshot().book, 'magpie', 'workbuddy-extra/deepseek-v4.1-flash').face?.via, 'user-override')
})

test('safe provider prefix normalization does not strip a different carrier or version', () => {
  assert.deepEqual(normalizeSourceIdentity(' WorkBuddy ', 'workbuddy/deepseek-v4.1-flash'), { provider: 'workbuddy', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(normalizeSourceIdentity('workbuddy', 'other/deepseek-v4.1-flash'), { provider: 'workbuddy', model: 'other/deepseek-v4.1-flash' })
})

test('known provider price wins; third-party DeepSeek stays flat under reference policy', () => {
  const actual = priceMessage(message({ provider: 'opencode-go', model: 'deepseek-v4.1-flash', time: peak }), snapshot())
  assert.equal(actual.face.via, 'direct')
  assert.equal(actual.multiplier, 1)
  nearBreakdown(actual.breakdown, { input: 1, cacheRead: 0.1, cacheWrite: 1, output: 4 })
})

test('weekday peak/off boundaries use Beijing time and weekends stay off', () => {
  for (const [time, expected] of [
    ['2026-11-13T08:59:59+08:00', false], ['2026-11-13T09:00:00+08:00', true],
    ['2026-11-13T11:59:59+08:00', true], ['2026-11-13T12:00:00+08:00', false],
    ['2026-11-13T13:59:59+08:00', false], ['2026-11-13T14:00:00+08:00', true],
    ['2026-11-13T17:59:59+08:00', true], ['2026-11-13T18:00:00+08:00', false],
    ['2026-11-14T10:00:00+08:00', false], ['2026-11-15T10:00:00+08:00', false],
  ]) assert.equal(isBeijingPeak(at(time)), expected, time)
  assert.equal(isBeijingPeak(NaN), false)
})

test('cache rate zero is preserved, missing input/output invalidates entries, and plan branches are excluded', () => {
  const book = pricesBookOf({
    zero: { models: { free: { cost: { input: 1, output: 2, cache_read: 0, cache_write: 0 } }, bad: { cost: { output: 1 } } } },
    'kimi-code-plan-global': { models: { k3: { cost: rate(0, 0, 0) } } },
    moonshotai: { models: { 'kimi-k3': { cost: rate(3, 15, 0.3) } } },
  })
  assert.deepEqual(priceResolutionOf(book, 'zero', 'free').face.rate, { hit: 0, miss: 1, write: 0, out: 2 })
  assert.equal(priceResolutionOf(book, 'zero', 'bad').kind, 'unpriced')
  assert.equal(book.index.branches.has('kimi-code-plan-global'), false)
  assert.equal(priceResolutionOf(book, 'kimi-code-plan-global', 'k3').face.pid, 'moonshotai')
})

test('normalization, maker lookup, and ambiguity never guess a nearby model version', () => {
  const book = pricesBookOf({
    anthropic: { models: { 'claude-example-4-5-20250929': { cost: rate(2, 10, 0.2), canonical_model_id: 'anthropic/claude-example-4-5' } } },
    carrier1: { models: { mystery: { cost: rate(1, 2, 0.1) } } },
    carrier2: { models: { mystery: { cost: rate(3, 4, 0.3) } } },
  })
  assert.equal(priceResolutionOf(book, 'anthropic', 'claude-example-4.5').face.via, 'branch-normalized')
  assert.equal(priceResolutionOf(book, 'unknown-route', 'claude-example-4.5').face.pid, 'anthropic')
  assert.equal(priceResolutionOf(book, 'unknown-route', 'mystery').miss.reason, 'ambiguous')
  assert.equal(priceResolutionOf(book, 'anthropic', 'claude-example-4.6').kind, 'unpriced')
})

test('partial totals retain priced dollars and missing/override provenance; empty periods cost zero', () => {
  const sum = createPricingAccumulator(snapshot())
  assert.equal(sum.result().totalUsd, 0)
  assert.equal(sum.result().complete, true)
  sum.add(message({ provider: 'workbuddy', model: 'deepseek-v4.1-flash' }))
  sum.add(message({ provider: 'unknown', model: 'private-model' }))
  const result = sum.result()
  near(result.totalUsd, 0.903)
  assert.equal(result.status, 'partial')
  assert.equal(result.pricedRequests, 1)
  assert.equal(result.unpricedRequests, 1)
  assert.equal(result.missing[0].model, 'private-model')
  assert.equal(result.fallbacks[0].via, 'user-override')
  const unavailable = createPricingAccumulator(snapshot(null)); unavailable.add(message())
  assert.equal(unavailable.result().totalUsd, null)
  assert.equal(unavailable.result().status, 'unavailable')
})

test('catalog deduplicates concurrent fetches and observes the one-hour TTL with an injected clock', async () => {
  let clock = 100, calls = 0, release
  const wait = new Promise((resolve) => { release = resolve })
  const catalog = createPricingCatalog({ now: () => clock, fetchImpl: async (_url, init) => {
    calls += 1
    assert.match(init.headers['user-agent'], /Mozilla/)
    assert.equal(init.headers.accept, 'application/json')
    await wait
    return response()
  } })
  const first = catalog.read(), concurrent = catalog.read()
  await Promise.resolve()
  assert.equal(calls, 1)
  release()
  assert.equal((await first).version, 1)
  assert.equal((await concurrent).version, 1)
  clock += 3_599_999; await catalog.read(); assert.equal(calls, 1)
  clock += 1; assert.equal((await catalog.read()).version, 2); assert.equal(calls, 2)
  catalog.dispose()
})

test('initial errors, empty catalogs and stale errors back off for 30 seconds and recover', async () => {
  let clock = 0, mode = 'error', calls = 0
  const catalog = createPricingCatalog({ now: () => clock, fetchImpl: async () => {
    calls += 1
    if (mode === 'error') throw new Error('offline')
    return response(mode === 'empty' ? {} : catalogBody())
  } })
  assert.equal((await catalog.read()).book, null)
  clock = 29_999; await catalog.read(); assert.equal(calls, 1)
  clock = 30_000; mode = 'empty'; assert.equal((await catalog.read()).book, null)
  clock = 60_000; mode = 'ok'; const good = await catalog.read(); assert.equal(good.version, 1)
  clock += 3_600_000; mode = 'error'; const stale = await catalog.read()
  assert.equal(stale.book, good.book); assert.equal(stale.stale, true)
  assert.equal(stale.fetchedAt, 60_000)
  const failures = calls; clock += 29_999; await catalog.read(); assert.equal(calls, failures)
  clock += 1; mode = 'ok'; const fresh = await catalog.read()
  assert.equal(fresh.stale, false); assert.equal(fresh.version, 2)
  catalog.dispose()
})

test('catalog timeout includes a stalled body parser and isolated instances never share data', async () => {
  const stalled = createPricingCatalog({ timeoutMs: 5, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) })
  assert.equal((await stalled.read()).book, null)
  const other = createPricingCatalog({ fetchImpl: async () => response() })
  assert.equal(other.snapshot().book, null)
  assert.equal((await other.read()).version, 1)
  assert.equal(stalled.snapshot().book, null)
  stalled.dispose(); other.dispose()
})
