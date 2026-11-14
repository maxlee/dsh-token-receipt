/**
 * Token receipt — Host half.
 *
 * Serves one read-only JSON endpoint that aggregates recorded assistant
 * `usage` from every stored DSH session into a single local day. The browser
 * half renders the receipt printer; only the public model price catalogue is fetched.
 */

import { statSync } from 'node:fs'
import { createPricingCatalog, createPricingAccumulator } from './pricing.js'

const ROUTE = '/api/token-receipt'
const DAY_MS = 24 * 60 * 60 * 1000
const CACHE_TTL_MS = 10_000
const RECENT_DAYS = 3

export const name = 'token-receipt'
export const inject = ['webServer']

function sendJson(res, status, body, headOnly = false) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': payload.length,
  })
  if (headOnly) return res.end()
  res.end(payload)
}

function localDayBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return { from: start, to: start + DAY_MS }
}

function compactDate(timestamp) {
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0
}

function hashSuffix(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 4)
}

function messageText(message) {
  const content = message && Array.isArray(message.content) ? message.content : []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      return block.text.trim().replace(/\s+/g, ' ')
    }
  }
  return ''
}

function shortTitle(text) {
  if (!text) return 'Untitled session'
  return text.length > 46 ? `${text.slice(0, 45)}…` : text
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Read every usage-bearing assistant message once for one session. Results are
 * filtered by day later, so one cached scan can serve every date.
 */
async function loadSessionUsage(query, record) {
  const header = record && record.header
  if (!header || typeof header.id !== 'string') return null
  let snapshot
  try {
    snapshot = await query.readSession(header.id)
  } catch {
    return null
  }
  if (!snapshot || !Array.isArray(snapshot.events)) return null
  const inherited = Number(snapshot.inheritedEventCount) || 0
  let title = ''

  for (const candidate of snapshot.events) {
    if (candidate && candidate.type === 'user/message') {
      const body = candidate.data && candidate.data.message ? candidate.data.message : candidate.data
      const text = messageText(body)
      if (text !== '' && !text.startsWith('<')) {
        title = text
        break
      }
    }
  }

  const messages = []
  for (const event of snapshot.events) {
    if (!event || event.type !== 'assistant/message') continue
    if (typeof event.seq === 'number' && event.seq < inherited) continue
    if (typeof event.time !== 'number') continue
    const usage = event.data && event.data.usage
    if (!usage) continue
    const message = event.data.message || {}
    const source = message.source || {}
    const total = finite(usage.totalTokens) || finite(usage.inputTokens) + finite(usage.cacheReadTokens) + finite(usage.cacheWriteTokens) + finite(usage.outputTokens)
    if (total <= 0) continue
    messages.push({
      time: event.time,
      total,
      input: finite(usage.inputTokens),
      output: finite(usage.outputTokens),
      cacheRead: finite(usage.cacheReadTokens),
      cacheWrite: finite(usage.cacheWriteTokens),
      reasoning: finite(usage.reasoningTokens),
      provider: typeof source.provider === 'string' ? source.provider : '',
      model: typeof source.model === 'string' && source.model !== '' ? source.model : 'unknown',
    })
  }

  return {
    id: header.id,
    title: shortTitle(title),
    origin: header.origin === 'subagent' ? 'subagent' : 'session',
    messages,
  }
}

async function cachedSessionUsage(query, record, revision, sessionUsageCache) {
  const id = record.header.id
  const hit = sessionUsageCache.get(id)
  const key = revision == null ? null : String(revision)
  if (hit && key !== null && hit.revision === key) return hit.value
  const value = await loadSessionUsage(query, record)
  if (key !== null) {
    sessionUsageCache.set(id, { revision: key, value })
    if (sessionUsageCache.size > 512) {
      const oldest = sessionUsageCache.keys().next().value
      if (oldest !== undefined) sessionUsageCache.delete(oldest)
    }
  }
  return value
}

/**
 * Narrow the candidate sessions before reading their logs. A session created
 * long ago can still be used today, so recency uses the persisted log's
 * modification time and the live-session set rather than creation time alone.
 */
async function candidateRecords(ctx, query, from, to) {
  const records = await query.listSessions()
  const persistence = ctx.get('sessionPersistence')
  const live = ctx.get('sessions')
  const liveIds = new Set()
  if (live && typeof live.list === 'function') {
    try {
      for (const session of live.list()) liveIds.add(session.id)
    } catch {
      /* the live set is an optimization only */
    }
  }
  const revisions = new Map()
  const paths = new Map()
  if (persistence && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list()
      for (const snapshot of snapshots) {
        if (!snapshot || !snapshot.header) continue
        revisions.set(snapshot.header.id, snapshot.revision)
        const path = snapshot.location && snapshot.location.path
        if (typeof path === 'string') paths.set(snapshot.header.id, path)
      }
    } catch {
      /* fall back to reading whatever the query returns */
    }
  }
  const recentFloor = from - RECENT_DAYS * DAY_MS
  return records
    .filter((record) => {
      const header = record && record.header
      if (!header || typeof header.id !== 'string') return false
      if (header.createdAt && header.createdAt >= to) return false
      if (liveIds.has(header.id)) return true
      if (!header.createdAt || header.createdAt >= recentFloor) return true
      const path = paths.get(header.id)
      if (path !== undefined) {
        try {
          return statSync(path).mtimeMs >= from - 60_000
        } catch {
          return true
        }
      }
      return true
    })
    .map((record) => ({ record, revision: revisions.get(record.header.id) }))
}

async function computeBill(ctx, from, to, dateLabel, period, state, snapshot) {
  const query = ctx.get('sessionQuery')
  if (!query || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
    const error = new Error('Session history is unavailable in this profile.')
    error.statusCode = 503
    throw error
  }

  const candidates = await candidateRecords(ctx, query, from, to)
  const loaded = await mapLimit(candidates, 6, ({ record, revision }) => cachedSessionUsage(query, record, revision, state.sessionUsageCache))
  const rows = loaded.filter((row) => row && row.messages.length > 0)

  const totals = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requests: 0,
    sessions: 0,
    subagentSessions: 0,
  }
  const modelMap = new Map()
  const pricing = createPricingAccumulator(snapshot)
  const sessionRows = []

  for (const row of rows) {
    let requests = 0
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let reasoning = 0
    let total = 0
    let firstAt = 0
    let lastAt = 0
    for (const message of row.messages) {
      if (message.time < from || message.time >= to) continue
      requests += 1
      total += message.total
      input += message.input
      output += message.output
      cacheRead += message.cacheRead
      cacheWrite += message.cacheWrite
      reasoning += message.reasoning
      firstAt = firstAt === 0 || message.time < firstAt ? message.time : firstAt
      lastAt = message.time > lastAt ? message.time : lastAt
      const key = `${message.provider}\u0000${message.model}`
      const existing = modelMap.get(key) || {
        provider: message.provider, model: message.model, total: 0, input: 0, output: 0,
        cacheRead: 0, cacheWrite: 0, requests: 0, accumulator: createPricingAccumulator(snapshot),
      }
      existing.total += message.total
      existing.input += message.input
      existing.output += message.output
      existing.cacheRead += message.cacheRead
      existing.cacheWrite += message.cacheWrite
      existing.requests += 1
      const priced = pricing.add(message)
      existing.accumulator.add(message, priced)
      modelMap.set(key, existing)
    }

    if (requests === 0) continue
    totals.totalTokens += total
    totals.inputTokens += input
    totals.outputTokens += output
    totals.cacheReadTokens += cacheRead
    totals.cacheWriteTokens += cacheWrite
    totals.reasoningTokens += reasoning
    totals.requests += requests
    totals.sessions += 1
    if (row.origin === 'subagent') totals.subagentSessions += 1
    sessionRows.push({
      id: row.id,
      title: row.title,
      origin: row.origin,
      requests,
      total,
      input,
      output,
      firstAt,
      lastAt,
    })

  }

  const date = dateLabel || compactDate(from)
  const periodCode = period === 'week' ? 'W' : period === 'month' ? 'M' : 'D'
  const billNo = `TR-${periodCode}-${date.replaceAll('-', '')}-${hashSuffix(`${period}:${date}:${totals.totalTokens}:${totals.requests}`)}`

  return {
    ok: true,
    date,
    period,
    from,
    to,
    generatedAt: state.now(),
    billNo,
    totals,
    pricing: pricing.result(),
    models: [...modelMap.values()].map(({ accumulator, ...model }) => ({ ...model, pricing: accumulator.result() })).sort((a, b) => b.total - a.total),
    sessions: sessionRows.sort((a, b) => b.total - a.total).slice(0, 24),
  }
}

async function cachedBill(ctx, state, key, from, to, dateLabel, period, snapshot) {
  const { billCache } = state
  const now = state.now()
  const hit = billCache.get(key)
  if (hit && (hit.pending || now - hit.at < CACHE_TTL_MS)) return hit.promise
  const promise = computeBill(ctx, from, to, dateLabel, period, state, snapshot)
  const entry = { at: now, promise, pending: true }
  billCache.set(key, entry)
  if (billCache.size > 16) {
    const oldest = [...billCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) billCache.delete(oldest[0])
  }
  try {
    const bill = await promise
    entry.pending = false
    entry.at = state.now()
    if (bill.pricing.status === 'unavailable' && billCache.get(key) === entry) billCache.delete(key)
    return bill
  } catch (error) {
    if (billCache.get(key) === entry) billCache.delete(key)
    throw error
  }
}

/** One activation owns its caches and catalogue, including when tests run concurrently. */
export function createReceiptService(ctx, options = {}) {
  const now = options.now || Date.now
  const catalog = options.catalog || createPricingCatalog({ fetchImpl: options.fetchImpl, now })
  const state = { now, billCache: new Map(), sessionUsageCache: new Map() }

  async function getBill({ from, to, date, period = 'day' }) {
    const snapshot = await catalog.read()
    // Include labels and price state: a previously unavailable price can recover
    // without waiting for a session revision or an unrelated date to change.
    const key = JSON.stringify([from, to, date, period, snapshot.version, snapshot.stale])
    return cachedBill(ctx, state, key, from, to, date, period, snapshot)
  }

  async function handler(req, res) {
    const headOnly = req.method === 'HEAD'
    if (req.method !== 'GET' && !headOnly) {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' })
      return res.end()
    }
    let url
    try {
      url = new URL(req.url || '/', 'http://token-receipt.local')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Invalid request.' }, headOnly)
    }
    const defaultBounds = localDayBounds(new Date(now()))
    const fromParam = url.searchParams.get('from')
    const toParam = url.searchParams.get('to')
    const from = fromParam === null ? NaN : Number(fromParam)
    const to = toParam === null ? NaN : Number(toParam)
    const safeFrom = Number.isFinite(from) ? from : defaultBounds.from
    const safeTo = Number.isFinite(to) && to > safeFrom ? to : safeFrom + DAY_MS
    const dateLabel = url.searchParams.get('date') || compactDate(safeFrom)
    const requestedPeriod = url.searchParams.get('period')
    const period = requestedPeriod === 'week' || requestedPeriod === 'month' ? requestedPeriod : 'day'
    try {
      const bill = await getBill({ from: safeFrom, to: safeTo, date: dateLabel, period })
      return sendJson(res, 200, bill, headOnly)
    } catch (error) {
      const statusCode = error && Number.isInteger(error.statusCode) ? error.statusCode : 500
      return sendJson(res, statusCode, { ok: false, error: error instanceof Error ? error.message : String(error) }, headOnly)
    }
  }

  return {
    getBill,
    handler,
    dispose() { state.billCache.clear(); state.sessionUsageCache.clear(); catalog.dispose?.() },
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const service = createReceiptService(ctx)
    const unregister = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: service.handler })
    return () => { unregister(); service.dispose() }
  }, 'token-receipt: usage and reference pricing route')
}
