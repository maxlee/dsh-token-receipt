import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, utimesSync, unlinkSync } from 'node:fs'
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

test('package.json scripts.test avoids bare directory args that break Node 22/24 test runner', () => {
  const assertCompatibleTestScript = (script) => {
    assert.equal(typeof script, 'string', 'scripts.test must be a string')
    const match = /^node\s+--test(?:\s+(.*))?$/.exec(script.trim())
    assert.ok(match, `expected node --test command, got: ${script}`)
    const args = (match[1] ?? '').trim()
    assert.ok(
      args === '' || !/^(?:\.\/)?[\w.-]+\/?$/.test(args),
      `bare directory argument (${args}) fails with MODULE_NOT_FOUND on Node 22/24`,
    )
    assert.ok(
      args === '' || /^(?:"[^"]*\*[^"]*\.test\.js"|'[^']*\*[^']*\.test\.js')$/.test(args),
      `scripts.test must use default discovery or a quoted glob pattern ("tests/*.test.js"), got: ${script}`,
    )
  }

  assert.throws(
    () => assertCompatibleTestScript('node --test tests/'),
    /MODULE_NOT_FOUND/,
  )
  for (const broken of ['node --test tests', 'node --test ./tests/', 'node --test tests/*.test.js']) {
    assert.throws(() => assertCompatibleTestScript(broken))
  }
  assert.doesNotThrow(() => assertCompatibleTestScript('node --test'))
  assert.doesNotThrow(() => assertCompatibleTestScript('node --test "tests/*.test.js"'))

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assertCompatibleTestScript(pkg.scripts.test)
})

test('days30, days90, and all periods compute bounds, billNo prefixes, firstAt/lastAt, and non-1970 fallback dates', async () => {
  const fixedNow = new Date(2026, 10, 17, 15, 30, 0).getTime()
  const dayStart = new Date(2026, 10, 17).getTime()
  const dayEnd = new Date(2026, 10, 18).getTime()
  const days30Start = new Date(2026, 10, 17 - 29).getTime()
  const days90Start = new Date(2026, 10, 17 - 89).getTime()
  const localAt = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0).getTime()

  const events = [
    { type: 'assistant/message', time: localAt(2025, 3, 10, 9, 15), data: { usage: { inputTokens: M }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', time: localAt(2026, 9, 5, 14, 0), data: { usage: { inputTokens: M }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', time: localAt(2026, 11, 1, 10, 30), data: { usage: { inputTokens: M }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', time: localAt(2026, 11, 17, 11, 45), data: { usage: { inputTokens: M }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
    { type: 'assistant/message', time: localAt(2026, 11, 18, 0, 5), data: { usage: { inputTokens: M }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } },
  ]
  const service = createReceiptService(context(events), {
    catalog: staticCatalog(),
    now: () => fixedNow,
  })

  const bill30 = await service.getBill({ from: days30Start, to: dayEnd, date: '2026-11-17', period: 'days30' })
  assert.equal(bill30.period, 'days30')
  assert.equal(bill30.totals.requests, 2)
  assert.equal(bill30.firstAt, localAt(2026, 11, 1, 10, 30))
  assert.equal(bill30.lastAt, localAt(2026, 11, 17, 11, 45))
  assert.match(bill30.billNo, /^TR-30D-20261117-[0-9A-F]{4}$/)

  const bill90 = await service.getBill({ from: days90Start, to: dayEnd, period: 'days90' })
  assert.equal(bill90.period, 'days90')
  assert.equal(bill90.date, '2026-11-17')
  assert.equal(bill90.totals.requests, 3)
  assert.equal(bill90.firstAt, localAt(2026, 9, 5, 14, 0))
  assert.equal(bill90.lastAt, localAt(2026, 11, 17, 11, 45))
  assert.match(bill90.billNo, /^TR-90D-20261117-[0-9A-F]{4}$/)

  const billAll = await service.getBill({ from: 1, to: dayEnd, period: 'all' })
  assert.equal(billAll.period, 'all')
  assert.equal(billAll.date, '2026-11-17')
  assert.equal(billAll.totals.requests, 4)
  assert.equal(billAll.firstAt, localAt(2025, 3, 10, 9, 15))
  assert.equal(billAll.lastAt, localAt(2026, 11, 17, 11, 45))
  assert.match(billAll.billNo, /^TR-ALL-20261117-[0-9A-F]{4}$/)

  const emptyWindow = await service.getBill({ from: localAt(2024, 1, 1), to: localAt(2024, 1, 2), date: '2024-01-01', period: 'day' })
  assert.equal(emptyWindow.totals.requests, 0)
  assert.equal(emptyWindow.firstAt, null)
  assert.equal(emptyWindow.lastAt, null)

  for (const [period, expectedFrom, expectedRequests, prefix] of [
    ['days30', days30Start, 2, 'TR-30D-20261117-'],
    ['days90', days90Start, 3, 'TR-90D-20261117-'],
    ['all', 1, 4, 'TR-ALL-20261117-'],
  ]) {
    const res = mockResponse()
    await service.handler({ method: 'GET', url: `/api/token-receipt?period=${period}` }, res)
    assert.equal(res.status, 200)
    const bill = JSON.parse(res.body.toString())
    assert.equal(bill.period, period)
    assert.equal(bill.from, expectedFrom)
    assert.equal(bill.to, dayEnd)
    assert.equal(bill.date, '2026-11-17')
    assert.ok(!bill.date.startsWith('1970'), `fallback date must not be 1970 for ${period}`)
    assert.equal(bill.totals.requests, expectedRequests)
    assert.ok(bill.billNo.startsWith(prefix), `expected ${bill.billNo} to start with ${prefix}`)
  }

  const explicitRes = mockResponse()
  await service.handler({
    method: 'GET',
    url: `/api/token-receipt?period=days90&from=${days90Start}&to=${dayEnd}&date=2026-Q4`,
  }, explicitRes)
  const explicitBill = JSON.parse(explicitRes.body.toString())
  assert.equal(explicitBill.period, 'days90')
  assert.equal(explicitBill.date, '2026-Q4')
  assert.ok(explicitBill.billNo.startsWith('TR-90D-2026Q4-'))

  const zeroFromAll = mockResponse()
  await service.handler({ method: 'GET', url: '/api/token-receipt?period=all&from=0' }, zeroFromAll)
  const zeroFromBill = JSON.parse(zeroFromAll.body.toString())
  assert.equal(zeroFromBill.from, 1)
  assert.equal(zeroFromBill.date, '2026-11-17')

  const unknownPeriod = mockResponse()
  await service.handler({ method: 'GET', url: '/api/token-receipt?period=bogus' }, unknownPeriod)
  const unknownBill = JSON.parse(unknownPeriod.body.toString())
  assert.equal(unknownBill.period, 'day')
  assert.equal(unknownBill.from, dayStart)
  assert.ok(unknownBill.billNo.startsWith('TR-D-20261117-'))

  service.dispose()
})

test('historical sessions created months or years earlier are included in days90/all and bill firstAt/lastAt span beyond top-24 sessions', async () => {
  const fixedNow = new Date(2026, 10, 17, 15, 30, 0).getTime()
  const localAt = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min, 0).getTime()

  const updatedOldPath = join(tmpdir(), `token-receipt-old-updated-${process.pid}-${Date.now()}.jsonl`)
  const ancientPath = join(tmpdir(), `token-receipt-ancient-${process.pid}-${Date.now()}.jsonl`)
  writeFileSync(updatedOldPath, '')
  writeFileSync(ancientPath, '')
  try {
    const updatedSec = Math.floor(localAt(2026, 9, 8, 10, 0) / 1000)
    const ancientSec = Math.floor(localAt(2024, 2, 10, 8, 0) / 1000)
    utimesSync(updatedOldPath, updatedSec, updatedSec)
    utimesSync(ancientPath, ancientSec, ancientSec)

    const sessions = [
      {
        id: 'ancient-2024',
        createdAt: localAt(2024, 2, 10, 8, 0),
        path: ancientPath,
        events: [{ type: 'assistant/message', time: localAt(2024, 2, 10, 8, 5), data: { usage: { inputTokens: 100 }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } }],
      },
      {
        id: 'old-created-recent-activity',
        createdAt: localAt(2024, 6, 1, 9, 0),
        path: updatedOldPath,
        events: [{ type: 'assistant/message', time: localAt(2026, 9, 8, 10, 0), data: { usage: { inputTokens: 200 }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } }],
      },
      {
        id: 'months-ago-90d',
        createdAt: localAt(2026, 9, 1, 9, 0),
        events: [{ type: 'assistant/message', time: localAt(2026, 9, 1, 9, 15), data: { usage: { inputTokens: 300 }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } }],
      },
      {
        id: 'latest-low-tokens',
        createdAt: localAt(2026, 11, 17, 15, 0),
        events: [{ type: 'assistant/message', time: localAt(2026, 11, 17, 15, 10), data: { usage: { inputTokens: 50 }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } }],
      },
    ]
    for (let i = 0; i < 24; i += 1) {
      sessions.push({
        id: `heavy-${i}`,
        createdAt: localAt(2026, 11, 10, 12, 0),
        events: [{ type: 'assistant/message', time: localAt(2026, 11, 10, 12, i), data: { usage: { inputTokens: 10_000 + i }, message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } }],
      })
    }

    const byId = new Map(sessions.map((s) => [s.id, s]))
    const query = {
      listSessions: async () => sessions.map((s) => ({ header: { id: s.id, createdAt: s.createdAt } })),
      readSession: async (id) => ({ events: byId.get(id).events, inheritedEventCount: 0 }),
    }
    const persistence = {
      list: async () => sessions.map((s) => ({
        header: { id: s.id },
        revision: 1,
        ...(s.path ? { location: { path: s.path } } : {}),
      })),
    }

    const service = createReceiptService({
      get: (name) => name === 'sessionQuery' ? query : name === 'sessionPersistence' ? persistence : undefined,
    }, { catalog: staticCatalog(), now: () => fixedNow })

    const res30 = mockResponse()
    await service.handler({ method: 'GET', url: '/api/token-receipt?period=days30' }, res30)
    const bill30 = JSON.parse(res30.body.toString())
    assert.equal(bill30.totals.sessions, 25)
    assert.equal(bill30.sessions.length, 24)
    assert.equal(bill30.firstAt, localAt(2026, 11, 10, 12, 0))
    assert.equal(bill30.lastAt, localAt(2026, 11, 17, 15, 10), 'lastAt includes low-token session sliced out of top-24 sessions')

    const res90 = mockResponse()
    await service.handler({ method: 'GET', url: '/api/token-receipt?period=days90' }, res90)
    const bill90 = JSON.parse(res90.body.toString())
    assert.equal(bill90.totals.sessions, 27)
    assert.equal(bill90.firstAt, localAt(2026, 9, 1, 9, 15))
    assert.equal(bill90.lastAt, localAt(2026, 11, 17, 15, 10))

    const resAll = mockResponse()
    await service.handler({ method: 'GET', url: '/api/token-receipt?period=all' }, resAll)
    const billAll = JSON.parse(resAll.body.toString())
    assert.equal(billAll.totals.sessions, 28)
    assert.equal(billAll.firstAt, localAt(2024, 2, 10, 8, 5))
    assert.equal(billAll.lastAt, localAt(2026, 11, 17, 15, 10))
    assert.equal(billAll.date, '2026-11-17')
    assert.ok(billAll.billNo.startsWith('TR-ALL-20261117-'))
    service.dispose()

    const emptyService = createReceiptService(context([]), { catalog: staticCatalog(), now: () => fixedNow })
    const emptyAll = mockResponse()
    await emptyService.handler({ method: 'GET', url: '/api/token-receipt?period=all' }, emptyAll)
    const emptyBill = JSON.parse(emptyAll.body.toString())
    assert.equal(emptyBill.totals.requests, 0)
    assert.equal(emptyBill.firstAt, null)
    assert.equal(emptyBill.lastAt, null)
    assert.equal(emptyBill.date, '2026-11-17')
    assert.ok(emptyBill.billNo.startsWith('TR-ALL-20261117-'))
    emptyService.dispose()
  } finally {
    try { unlinkSync(updatedOldPath) } catch {}
    try { unlinkSync(ancientPath) } catch {}
  }
})
