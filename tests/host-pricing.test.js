import test from 'node:test'
import assert from 'node:assert/strict'
import { createReceiptService, apply } from '../index.js'
import { createPricingCatalog, pricesBookOf } from '../pricing.js'

const M = 1_000_000
const at = (date) => Date.parse(`${date}+08:00`)
const dayFrom = at('2026-11-13T00:00:00')
const dayTo = at('2026-11-14T00:00:00')
const raw = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
  'opencode-go': { models: { 'deepseek-v4.1-flash': { cost: { input: 1, output: 4, cache_read: 0.1 } } } },
}
const snapshot = (extras = {}) => ({ book: pricesBookOf(raw), version: 1, fetchedAt: 1, stale: false, source: 'https://models.dev/api.json', ...extras })
const staticCatalog = (value = snapshot()) => ({ read: async () => value, dispose() {} })
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`)
function event(time, provider = 'workbuddy', model = 'deepseek-v4.1-flash', usage = { inputTokens: M }) {
  return { type: 'assistant/message', time: at(time), data: { usage, message: { source: { provider, model } } } }
}
function context(events, options = {}) {
  let reads = 0
  const query = {
    listSessions: async () => [{ header: { id: 'same-id', createdAt: at('2026-11-01T00:00:00') } }],
    readSession: async () => { reads += 1; return { events, inheritedEventCount: options.inheritedEventCount || 0 } },
  }
  return { get: (name) => name === 'sessionQuery' ? query : name === 'sessionPersistence' ? { list: async () => [{ header: { id: 'same-id' }, revision: 1 }] } : undefined, reads: () => reads }
}
const billArgs = { from: dayFrom, to: dayTo, date: '2026-11-13', period: 'day' }
function mockResponse() {
  return { status: null, headers: null, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body },
  }
}

test('day/week/month totals price each event in its own peak period and keep providers separate', async () => {
  const ctx = context([
    event('2026-11-02T09:00:00'), // month only: peak $0.30
    event('2026-11-09T12:00:00'), // week: off $0.15
    event('2026-11-13T09:00:00'), // day: peak $0.30
    event('2026-11-13T12:00:00'), // day: off $0.15
    event('2026-11-13T09:00:00', 'opencode-go'), // distinct provider: flat $1
    event('2026-11-14T10:00:00'), // weekend off $0.15
  ])
  const service = createReceiptService(ctx, { catalog: staticCatalog() })
  const day = await service.getBill(billArgs)
  near(day.pricing.totalUsd, 1.45)
  assert.equal(day.models.length, 2)
  near(day.models.find((x) => x.provider === 'workbuddy').pricing.totalUsd, 0.45)
  near(day.models.find((x) => x.provider === 'opencode-go').pricing.totalUsd, 1)
  assert.equal(day.pricing.fallbacks[0].via, 'user-override')
  assert.equal(day.pricing.pricedRequests, 3)
  const week = await service.getBill({ from: at('2026-11-09T00:00:00'), to: at('2026-11-16T00:00:00'), date: '2026-11-09', period: 'week' })
  near(week.pricing.totalUsd, 1.75)
  const month = await service.getBill({ from: at('2026-11-01T00:00:00'), to: at('2026-12-01T00:00:00'), date: '2026-11', period: 'month' })
  near(month.pricing.totalUsd, 2.05)
  assert.equal(ctx.reads(), 1, 'session revision scan is cached within this service')
  service.dispose()
})

test('gateway-retained WorkBuddy route uses official peak policy without changing other carriers', async () => {
  const service = createReceiptService(context([
    event('2026-11-13T09:00:00', 'workbuddy', 'deepseek-v4.1-flash'),
    event('2026-11-13T09:00:00', 'workbuddy', 'workbuddy/deepseek-v4.1-flash'),
    event('2026-11-13T09:00:00', 'magpie', 'workbuddy/deepseek-v4.1-flash'),
    event('2026-11-13T09:00:00', 'opencode-go', 'deepseek-v4.1-flash'),
  ]), { catalog: staticCatalog() })
  const bill = await service.getBill(billArgs)
  near(bill.pricing.totalUsd, 1.9)
  assert.equal(bill.models.length, 4)
  const gateway = bill.models.find((model) => model.provider === 'magpie')
  near(gateway.pricing.totalUsd, 0.3)
  assert.equal(gateway.model, 'workbuddy/deepseek-v4.1-flash')
  assert.equal(gateway.pricing.fallbacks[0].via, 'user-override')
  assert.equal(gateway.pricing.fallbacks[0].peakPolicy, 'deepseek-official')
  assert.equal(gateway.pricing.fallbacks[0].provider, 'magpie')
  near(bill.models.find((model) => model.provider === 'opencode-go').pricing.totalUsd, 1)
  service.dispose()
})

test('cache-only usage is included, cache reads/writes have distinct amounts, and reasoning is not added', async () => {
  const ctx = context([event('2026-11-13T12:00:00', 'workbuddy', 'workbuddy/deepseek-v4.1-flash', {
    cacheReadTokens: M, cacheWriteTokens: M, outputTokens: M, reasoningTokens: M,
  })])
  const service = createReceiptService(ctx, { catalog: staticCatalog() })
  const bill = await service.getBill(billArgs)
  near(bill.pricing.totalUsd, 0.753)
  assert.equal(bill.totals.totalTokens, 3 * M)
  assert.equal(bill.models[0].cacheRead, M)
  assert.equal(bill.models[0].cacheWrite, M)
  assert.deepEqual(bill.pricing.breakdown, { input: 0, cacheRead: 0.003, cacheWrite: 0.15, output: 0.6 })
  service.dispose()
})

test('unknown models stay null, mixed usage is partial, and empty periods are complete zero', async () => {
  const service = createReceiptService(context([
    event('2026-11-13T12:00:00'), event('2026-11-13T12:00:00', 'private', 'private-model'),
  ]), { catalog: staticCatalog() })
  const bill = await service.getBill(billArgs)
  near(bill.pricing.totalUsd, 0.15)
  assert.equal(bill.pricing.status, 'partial')
  assert.equal(bill.pricing.unpricedRequests, 1)
  assert.equal(bill.models.find((x) => x.provider === 'private').pricing.totalUsd, null)
  const empty = await service.getBill({ from: dayTo, to: dayTo + 86400000, date: '2026-11-14' })
  assert.equal(empty.pricing.totalUsd, 0)
  assert.equal(empty.pricing.status, 'complete')
  service.dispose()
})

test('API GET/HEAD expose pricing, POST is rejected, and unavailable history returns 503', async () => {
  const service = createReceiptService(context([event('2026-11-13T12:00:00')]), { catalog: staticCatalog() })
  const url = `/api/token-receipt?from=${dayFrom}&to=${dayTo}&date=2026-11-13&period=week`
  const res = mockResponse(); await service.handler({ method: 'GET', url }, res)
  assert.equal(res.status, 200)
  const bill = JSON.parse(res.body.toString()); assert.equal(bill.period, 'week'); near(bill.pricing.totalUsd, 0.15)
  const head = mockResponse(); await service.handler({ method: 'HEAD', url }, head)
  assert.equal(head.status, 200); assert.equal(head.body, undefined)
  const post = mockResponse(); await service.handler({ method: 'POST', url }, post)
  assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD')
  const unavailable = createReceiptService({ get: () => undefined }, { catalog: staticCatalog() })
  const fail = mockResponse(); await unavailable.handler({ method: 'GET', url }, fail); assert.equal(fail.status, 503)
  unavailable.dispose(); service.dispose()
})

test('bill cache keys include period/date and catalog version and recover after price fetch failures', async () => {
  let clock = 0, available = false, calls = 0
  const catalog = createPricingCatalog({ now: () => clock, fetchImpl: async () => {
    calls += 1
    if (!available) throw new Error('offline')
    return { ok: true, json: async () => raw }
  } })
  const service = createReceiptService(context([event('2026-11-13T12:00:00')]), { catalog, now: () => clock })
  const unavailable = await service.getBill(billArgs); assert.equal(unavailable.pricing.totalUsd, null)
  const otherLabel = await service.getBill({ ...billArgs, date: 'changed-label', period: 'month' })
  assert.equal(otherLabel.date, 'changed-label'); assert.equal(otherLabel.period, 'month')
  clock = 30_000; available = true
  const recovered = await service.getBill(billArgs); near(recovered.pricing.totalUsd, 0.15)
  assert.equal(recovered.pricing.status, 'complete'); assert.equal(calls, 2)
  // A new price version invalidates a bill even while its 10s result TTL is fresh.
  let state = snapshot()
  const mutable = createReceiptService(context([event('2026-11-13T12:00:00')]), { catalog: { read: async () => state }, now: () => 0 })
  near((await mutable.getBill(billArgs)).pricing.totalUsd, 0.15)
  const changed = structuredClone(raw); changed.deepseek.models['deepseek-v4-flash'].cost.input = 0.3
  state = snapshot({ book: pricesBookOf(changed), version: 2 })
  near((await mutable.getBill(billArgs)).pricing.totalUsd, 0.3)
  mutable.dispose(); service.dispose()
})

test('service instances do not share session caches even when IDs and revisions are identical', async () => {
  const first = createReceiptService(context([event('2026-11-13T12:00:00')]), { catalog: staticCatalog() })
  const second = createReceiptService(context([event('2026-11-13T12:00:00', 'workbuddy', 'deepseek-v4.1-flash', { inputTokens: 2 * M })]), { catalog: staticCatalog() })
  near((await first.getBill(billArgs)).pricing.totalUsd, 0.15)
  near((await second.getBill(billArgs)).pricing.totalUsd, 0.3)
  first.dispose(); second.dispose()
})

test('apply registers the existing route and disposes it through its activation effect', () => {
  let route, cleanup, removed = false
  const ctx = { get: () => undefined, effect: (fn) => { cleanup = fn() }, webServer: { register(value) { route = value; return () => { removed = true } } } }
  apply(ctx)
  assert.equal(route.path, '/api/token-receipt'); assert.equal(typeof route.handler, 'function')
  cleanup(); assert.equal(removed, true)
})
