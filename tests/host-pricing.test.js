import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, utimesSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('malformed event timestamps, non-finite seq, and inheritedEventCount are safely guarded', async () => {
  const validTime = at('2026-11-13T12:00:00')
  const events = [
    { ...event('2026-11-13T12:00:00'), seq: 0 },
    { ...event('2026-11-13T12:00:00'), seq: 1 },
    { ...event('2026-11-13T12:00:00'), seq: 2 },
    { ...event('2026-11-13T12:00:00'), seq: NaN },
    { type: 'assistant/message', seq: 3, time: NaN, data: { usage: { inputTokens: 99 * M }, message: { source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', seq: 4, time: Infinity, data: { usage: { inputTokens: 99 * M }, message: { source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', seq: 5, time: -Infinity, data: { usage: { inputTokens: 99 * M }, message: { source: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } } } },
  ]
  const service = createReceiptService(context(events, { inheritedEventCount: 2 }), { catalog: staticCatalog() })
  const day = await service.getBill(billArgs)
  assert.equal(day.totals.requests, 2)
  assert.equal(day.totals.totalTokens, 2 * M)
  assert.equal(day.sessions[0].firstAt, validTime)
  assert.equal(day.sessions[0].lastAt, validTime)
  const otherDay = await service.getBill({ from: dayTo, to: dayTo + 86_400_000, date: '2026-11-14', period: 'day' })
  assert.equal(otherDay.totals.requests, 0, 'NaN timestamps never leak into other periods')
  service.dispose()

  for (const badInherited of [Infinity, -Infinity, NaN, -5]) {
    const query = {
      listSessions: async () => [{ header: { id: 'bad-inh', createdAt: validTime } }],
      readSession: async () => ({ events: [{ ...event('2026-11-13T12:00:00'), seq: 0 }], inheritedEventCount: badInherited }),
    }
    const svc = createReceiptService({ get: (name) => name === 'sessionQuery' ? query : undefined }, { catalog: staticCatalog() })
    const bill = await svc.getBill(billArgs)
    assert.equal(bill.totals.requests, 1, `inheritedEventCount=${badInherited} falls back to 0`)
    svc.dispose()
  }
})

test('multi-block <...> user prompts extract clean titles, truncate by code point, and count subagent sessions', async () => {
  const sessions = {
    main: {
      header: { id: 'main', origin: 'session', createdAt: dayFrom },
      events: [
        {
          type: 'user/message',
          data: { message: { content: [
            { type: 'text', text: '  <system-reminder>internal context</system-reminder> ' },
            { type: 'text', text: '  Build   receipt   printer  ' },
          ] } },
        },
        event('2026-11-13T12:00:00'),
      ],
    },
    worker: {
      header: { id: 'worker', origin: 'subagent', createdAt: dayFrom },
      events: [
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: '<context>only tags</context>' }] } } },
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: `${'a'.repeat(44)}🚀🔥✨` }] } } },
        event('2026-11-13T12:00:00', 'workbuddy', 'deepseek-v4.1-flash', { inputTokens: 2 * M }),
      ],
    },
  }
  const query = {
    listSessions: async () => Object.values(sessions).map(({ header }) => ({ header })),
    readSession: async (id) => ({ events: sessions[id].events, inheritedEventCount: 0 }),
  }
  const service = createReceiptService({ get: (name) => name === 'sessionQuery' ? query : undefined }, { catalog: staticCatalog() })
  const bill = await service.getBill(billArgs)
  assert.equal(bill.totals.sessions, 2)
  assert.equal(bill.totals.subagentSessions, 1)
  const mainRow = bill.sessions.find((s) => s.id === 'main')
  const workerRow = bill.sessions.find((s) => s.id === 'worker')
  assert.equal(mainRow.title, 'Build receipt printer')
  assert.equal(mainRow.origin, 'session')
  assert.equal(workerRow.title, `${'a'.repeat(44)}🚀…`)
  assert.equal(workerRow.title.isWellFormed(), true)
  assert.equal(workerRow.origin, 'subagent')
  service.dispose()
})

test('HTTP query params reject empty/out-of-range timestamps, sanitize date labels, and honor DST day bounds', async () => {
  const fixedNow = at('2026-11-13T15:30:00')
  const service = createReceiptService(context([event('2026-11-13T12:00:00')]), {
    catalog: staticCatalog(),
    now: () => fixedNow,
  })

  for (const query of ['?from=', '?from=%20', '?from=0', '?from=-100', '?from=1e20', '?from=8640000000000000']) {
    const res = mockResponse()
    await service.handler({ method: 'GET', url: `/api/token-receipt${query}` }, res)
    assert.equal(res.status, 200)
    const bill = JSON.parse(res.body.toString())
    assert.ok(!bill.date.includes('NaN'), `unexpected NaN date for ${query}: ${bill.date}`)
    assert.ok(!bill.billNo.includes('NaN'), `unexpected NaN billNo for ${query}: ${bill.billNo}`)
    assert.ok(bill.from > 0 && bill.to > bill.from)
  }

  for (const badDate of ['../etc/passwd', '<script>', 'x'.repeat(33), '%20']) {
    const res = mockResponse()
    await service.handler({ method: 'GET', url: `/api/token-receipt?from=${dayFrom}&to=${dayTo}&date=${encodeURIComponent(badDate)}` }, res)
    const bill = JSON.parse(res.body.toString())
    assert.match(bill.date, /^\d{4}-\d{2}-\d{2}$/)
  }

  const validWeek = mockResponse()
  await service.handler({ method: 'GET', url: `/api/token-receipt?from=${dayFrom}&to=${dayTo}&date=2026-W46&period=week` }, validWeek)
  assert.equal(JSON.parse(validWeek.body.toString()).date, '2026-W46')

  const prevTz = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const springNoon = Date.parse('2026-03-08T12:00:00-04:00')
    const springMidnight = new Date(2026, 2, 8).getTime()
    const dstService = createReceiptService(context([]), { catalog: staticCatalog(), now: () => springNoon })

    const defaultSpring = mockResponse()
    await dstService.handler({ method: 'GET', url: '/api/token-receipt' }, defaultSpring)
    const springBill = JSON.parse(defaultSpring.body.toString())
    assert.equal(springBill.from, springMidnight)
    assert.equal(springBill.to - springBill.from, 23 * 3600 * 1000)

    const explicitSpring = mockResponse()
    await dstService.handler({ method: 'GET', url: `/api/token-receipt?from=${springMidnight}` }, explicitSpring)
    assert.equal(JSON.parse(explicitSpring.body.toString()).to - springMidnight, 23 * 3600 * 1000)

    const fallMidnight = new Date(2026, 10, 1).getTime()
    const explicitFall = mockResponse()
    await dstService.handler({ method: 'GET', url: `/api/token-receipt?from=${fallMidnight}` }, explicitFall)
    assert.equal(JSON.parse(explicitFall.body.toString()).to - fallMidnight, 25 * 3600 * 1000)
    dstService.dispose()
  } finally {
    if (prevTz === undefined) delete process.env.TZ
    else process.env.TZ = prevTz
  }
  service.dispose()
})

test('local/private unpriced sessions hit billCache when catalog loaded, and ?refresh=1 retries failed catalogs immediately', async () => {
  let listCalls = 0
  const localQuery = {
    listSessions: async () => { listCalls += 1; return [{ header: { id: 'local-1', createdAt: dayFrom } }] },
    readSession: async () => ({ events: [event('2026-11-13T12:00:00', 'ollama', 'local-llama')], inheritedEventCount: 0 }),
  }
  const localService = createReceiptService({ get: (name) => name === 'sessionQuery' ? localQuery : undefined }, {
    catalog: staticCatalog(),
    now: () => 1_000,
  })
  const firstLocal = await localService.getBill(billArgs)
  assert.equal(firstLocal.pricing.status, 'unavailable')
  assert.equal(firstLocal.pricing.totalUsd, null)
  await localService.getBill(billArgs)
  assert.equal(listCalls, 1, 'billCache caches local/private unpriced bills when models.dev book is loaded')
  localService.dispose()

  let clock = 0, available = false, fetchCalls = 0
  const retryService = createReceiptService(context([event('2026-11-13T12:00:00')]), {
    now: () => clock,
    fetchImpl: async () => {
      fetchCalls += 1
      if (!available) throw new Error('offline')
      return { ok: true, status: 200, json: async () => raw }
    },
  })
  const baseUrl = `/api/token-receipt?from=${dayFrom}&to=${dayTo}&date=2026-11-13&period=day`

  const initial = mockResponse()
  await retryService.handler({ method: 'GET', url: baseUrl }, initial)
  assert.equal(JSON.parse(initial.body.toString()).pricing.totalUsd, null)
  assert.equal(fetchCalls, 1)

  available = true
  clock = 500
  const tooSoon = mockResponse()
  await retryService.handler({ method: 'GET', url: `${baseUrl}&refresh=1` }, tooSoon)
  assert.equal(JSON.parse(tooSoon.body.toString()).pricing.totalUsd, null)
  assert.equal(fetchCalls, 1)

  clock = 1_500
  const unforced = mockResponse()
  await retryService.handler({ method: 'GET', url: baseUrl }, unforced)
  assert.equal(JSON.parse(unforced.body.toString()).pricing.totalUsd, null)
  assert.equal(fetchCalls, 1)

  const forced = mockResponse()
  await retryService.handler({ method: 'GET', url: `${baseUrl}&refresh=1` }, forced)
  const recovered = JSON.parse(forced.body.toString())
  assert.equal(recovered.pricing.status, 'complete')
  near(recovered.pricing.totalUsd, 0.15)
  assert.equal(fetchCalls, 2)
  retryService.dispose()
})

test('sessionUsageCache evicts true LRU, skips statSync when revision is cached, and tolerates non-array session lists', async () => {
  let activeIds = Array.from({ length: 512 }, (_, i) => `s-${i}`)
  const readsById = new Map()
  let clock = 0
  const lruQuery = {
    listSessions: async () => activeIds.map((id) => ({ header: { id, createdAt: dayFrom } })),
    readSession: async (id) => {
      readsById.set(id, (readsById.get(id) || 0) + 1)
      return { events: [event('2026-11-13T12:00:00')], inheritedEventCount: 0 }
    },
  }
  const lruPersistence = {
    list: async () => activeIds.map((id) => ({ header: { id }, revision: 1 })),
  }
  const lruService = createReceiptService({
    get: (name) => name === 'sessionQuery' ? lruQuery : name === 'sessionPersistence' ? lruPersistence : undefined,
  }, { catalog: staticCatalog(), now: () => clock })

  await lruService.getBill(billArgs)
  assert.equal(readsById.get('s-0'), 1)

  // Touch s-0 so s-1 becomes least-recently-used, then insert s-512 to trigger eviction.
  clock += 20_000
  activeIds = ['s-0']
  await lruService.getBill(billArgs)
  assert.equal(readsById.get('s-0'), 1)

  clock += 20_000
  activeIds = ['s-512']
  await lruService.getBill(billArgs)

  clock += 20_000
  activeIds = ['s-0', 's-1']
  await lruService.getBill(billArgs)
  assert.equal(readsById.get('s-0'), 1, 's-0 stayed cached after LRU refresh')
  assert.equal(readsById.get('s-1'), 2, 's-1 was evicted as least-recently-used')
  lruService.dispose()

  // Verify candidateRecords skips statSync when (id, revision) is already cached.
  const tempPath = join(tmpdir(), `token-receipt-test-${process.pid}-${Date.now()}.jsonl`)
  writeFileSync(tempPath, '')
  try {
    const validSec = Math.floor(dayFrom / 1000)
    utimesSync(tempPath, validSec, validSec)
    let rev = 1, oldReads = 0, t = 0
    const oldCreatedAt = dayFrom - 30 * 86_400_000
    const oldQuery = {
      listSessions: async () => [{ header: { id: 'old-session', createdAt: oldCreatedAt } }],
      readSession: async () => { oldReads += 1; return { events: [event('2026-11-13T12:00:00')], inheritedEventCount: 0 } },
    }
    const oldPersistence = {
      list: async () => [{ header: { id: 'old-session' }, revision: rev, location: { path: tempPath } }],
    }
    const oldService = createReceiptService({
      get: (name) => name === 'sessionQuery' ? oldQuery : name === 'sessionPersistence' ? oldPersistence : undefined,
    }, { catalog: staticCatalog(), now: () => t })

    assert.equal((await oldService.getBill(billArgs)).totals.requests, 1)
    assert.equal(oldReads, 1)

    // Backdate mtime to 1970: cached revision=1 skips statSync and keeps the session without re-reading.
    utimesSync(tempPath, 0, 0)
    t += 20_000
    assert.equal((await oldService.getBill(billArgs)).totals.requests, 1)
    assert.equal(oldReads, 1)

    // Once revision changes to 2, statSync runs again and filters out the 1970 mtime session.
    rev = 2
    t += 20_000
    assert.equal((await oldService.getBill(billArgs)).totals.requests, 0)
    assert.equal(oldReads, 1)
    oldService.dispose()
  } finally {
    try { unlinkSync(tempPath) } catch {}
  }

  // Non-array responses from listSessions / persistence.list do not crash.
  const nonArrayService = createReceiptService({
    get: (name) => name === 'sessionQuery'
      ? { listSessions: async () => null, readSession: async () => null }
      : name === 'sessionPersistence' ? { list: async () => 'invalid' } : undefined,
  }, { catalog: staticCatalog() })
  assert.equal((await nonArrayService.getBill(billArgs)).totals.requests, 0)
  nonArrayService.dispose()
})
