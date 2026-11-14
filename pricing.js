/**
 * Model price identity/resolution adapted from dsh-context (Apache-2.0).
 * Copyright 2025 bowenliang123. Source commit d81325ec6bab9dae9bf83e7a866ac74119504e18.
 * Modified for Token Receipt: self-contained JS, catalog lifecycle, WorkBuddy
 * reference override, message-level peak pricing and amount aggregation.
 * See THIRD_PARTY_NOTICES.md and licenses/dsh-context-LICENSE.txt.
 */

const asRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null

const GATEWAY_PREFIXES = [
  'accounts/fireworks/models/',
  'accounts/fireworks/routers/',
  'workers-ai/',
  '@cf/',
  'hf:',
]

const RESOURCE_PREFIXES = ['global.', 'us.', 'eu.', 'apac.']

const RESOURCE_SUFFIXES = [
  /@default$/i,
  /@\d{8}$/,
  /-v\d+(?::\d+)?$/i,
  /:\d+$/,
  /-\d{8}$/,
  /-\d{6}$/,
]

const FAMILY_VENDORS = [
  ['codestral-', 'mistral'],
  ['pixtral-', 'mistral'],
  ['nemotron-', 'nvidia'],
  ['deepseek-', 'deepseek'],
  ['minimax-', 'minimax'],
  ['mimo-', 'xiaomi'],
  ['command-', 'cohere'],
  ['gemini-', 'google'],
  ['gemma-', 'google'],
  ['claude-', 'anthropic'],
  ['llama-', 'meta'],
  ['mistral-', 'mistral'],
  ['grok-', 'xai'],
  ['kimi-', 'moonshotai'],
  ['glm-', 'zhipuai'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['o4-', 'openai'],
  ['qwen', 'alibaba'],
]

function lowerModelId(id) {
  return id.trim().toLowerCase()
}

function bareModelOf(id) {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

function orgOf(id) {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash).toLowerCase() : undefined
}

function labOf(canonical) {
  const slash = canonical.indexOf('/')
  return slash > 0 ? canonical.slice(0, slash).toLowerCase() : undefined
}

function stripPrefixes(input, prefixes) {
  let out = input
  let changed = true
  while (changed) {
    changed = false
    for (const prefix of prefixes) {
      if (!out.startsWith(prefix)) continue
      out = out.slice(prefix.length)
      changed = true
      break
    }
  }
  return out
}

function normalizeModelId(id) {
  let out = stripPrefixes(lowerModelId(id), GATEWAY_PREFIXES)
  out = stripPrefixes(out, RESOURCE_PREFIXES)
  let changed = true
  while (changed) {
    changed = false
    for (const suffix of RESOURCE_SUFFIXES) {
      if (!suffix.test(out)) continue
      out = out.replace(suffix, '')
      changed = true
      break
    }
    if (!changed && out.endsWith('-latest')) {
      out = out.slice(0, -'-latest'.length)
      changed = true
    }
  }
  out = out.replace(/v(\d+)p(\d+)/g, 'v$1-$2')
  out = out.replace(/[._]/g, '-')
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '')
  return out
}

function suffixKeys(key) {
  const parts = key.split(/[/-]+/).filter(part => part.length > 0)
  const tails = []
  for (let index = 1; index < parts.length; index++) tails.push(parts.slice(index).join('-'))
  return tails
}

function isSubscriptionPlanProvider(pid) {
  return /(?:^|-)(?:coding|code|token)-plan(?:-|$)/.test(pid.toLowerCase())
}

function familyVendorOf(model) {
  const bare = normalizeModelId(bareModelOf(model))
  return FAMILY_VENDORS.find(([prefix]) => bare.startsWith(prefix))?.[1]
}

const MODELS_DEV_PROVIDER_IDS = {
  'deepseek-official': 'deepseek',
  'deepseek-account': 'deepseek',
  'kimi-coding': 'moonshotai',
  'minimax-cn': 'minimax',
  'zai-coding-cn': 'zhipuai',
  'claude': 'anthropic',
  'codex': 'openai',
  'fireworks': 'fireworks-ai',
  'together': 'togetherai',
  'vercel-ai-gateway': 'vercel',
  'kimi-code-plan-global': 'moonshotai',
  'kimi-code-plan-cn': 'moonshotai-cn',
  'zai-coding-plan': 'zai',
  'zhipuai-coding-plan': 'zhipuai',
  'xiaomi-token-plan-ams': 'xiaomi',
  'xiaomi-token-plan-cn': 'xiaomi',
  'xiaomi-token-plan-sgp': 'xiaomi',
  'minimax-coding-plan': 'minimax',
  'minimax-cn-coding-plan': 'minimax-cn',
}

function modelsDevProviderOf(dshProviderId) {
  return MODELS_DEV_PROVIDER_IDS[dshProviderId] ?? dshProviderId
}

function isDeepSeekProvider(dshProviderId) {
  return modelsDevProviderOf(dshProviderId) === 'deepseek'
}

function sameRate(a, b) {
  const close = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))
  return close(a.hit, b.hit) && close(a.miss, b.miss) && close(a.write, b.write) && close(a.out, b.out)
}

function rateOfEntry(value) {
  const v = value
  if (v === null || typeof v !== 'object') return null
  const r = v
  const num = (x) => typeof x === 'number' && Number.isFinite(x)
  return num(r.hit) && num(r.miss) && num(r.write) && num(r.out)
    ? { hit: r.hit, miss: r.miss, write: r.write, out: r.out }
    : null
}

function pushCandidate(map, key, candidate) {
  const list = map.get(key)
  if (list === undefined) map.set(key, [candidate])
  else if (!list.some(existing => existing.pid === candidate.pid && sameRate(existing.rate, candidate.rate))) list.push(candidate)
}

function pushForms(map, forms, candidate) {
  for (const key of forms) pushCandidate(map, key, candidate)
}

export function priceIndexOf(
  prices,
  canonicalOf = {},
) {
  const byModel = new Map()
  const byNormalized = new Map()
  const branches = new Map()
  for (const pid of Object.keys(prices)) {
    if (isSubscriptionPlanProvider(pid)) continue
    const branchPrices = branchOf(prices, pid)
    if (branchPrices === null) continue
    const exact = new Map()
    const suffix = new Map()
    const normalized = new Map()
    const normalizedSuffix = new Map()
    const labs = new Set()
    for (const mid of Object.keys(branchPrices)) {
      const rate = branchPrices[mid]
      if (rateOfEntry(rate) === null) continue
      const canonical = canonicalOf[pid]?.[mid]
      const lab = canonical === undefined || canonical.length === 0 ? undefined : labOf(canonical)
      const candidate = {
        pid,
        mid,
        rate,
        ...canonical === undefined || canonical.length === 0 ? {} : { canonical },
        ...lab === undefined ? {} : { lab },
      }
      const lower = lowerModelId(mid)
      const normalizedKey = normalizeModelId(mid)
      const lowerSuffixes = suffixKeys(lower)
      const normalizedSuffixes = suffixKeys(normalizedKey)
      pushCandidate(exact, lower, candidate)
      pushForms(suffix, lowerSuffixes, candidate)
      pushCandidate(normalized, normalizedKey, candidate)
      pushForms(normalizedSuffix, normalizedSuffixes, candidate)
      pushCandidate(byModel, lower, candidate)
      pushCandidate(byNormalized, normalizedKey, candidate)
      if (lab !== undefined) labs.add(lab)
    }
    branches.set(pid, {
      pid,
      byExact: exact,
      bySuffix: suffix,
      byNormalized: normalized,
      byNormalizedSuffix: normalizedSuffix,
      labs,
      multiVendor: labs.size > 1,
    })
  }
  return { byModel, byNormalized, branches }
}

function pickCandidates(candidates) {
  if (candidates.length === 0) return { kind: 'miss' }
  const first = candidates[0]
  return candidates.every(candidate => sameRate(candidate.rate, first.rate))
    ? { kind: 'hit', candidate: first }
    : { kind: 'ambiguous', count: candidates.length }
}

function collect(map, keys) {
  const out = []
  for (const key of keys) out.push(...map.get(key) ?? [])
  return out
}

function faceOf(candidate, via, confidence) {
  return {
    pid: candidate.pid,
    mid: candidate.mid,
    rate: candidate.rate,
    via,
    confidence,
    ...candidate.canonical === undefined ? {} : { canonical: candidate.canonical },
  }
}

function lookupBranch(branch, model) {
  const exact = lowerModelId(model)
  const normalized = normalizeModelId(model)
  const stages

     = [
    { map: branch.byExact, keys: [exact], via: 'direct', confidence: 'high' },
    { map: branch.bySuffix, keys: [exact], via: 'branch-suffix', confidence: 'high' },
    { map: branch.byNormalized, keys: [normalized], via: 'branch-normalized', confidence: 'medium' },
    { map: branch.byNormalizedSuffix, keys: [normalized], via: 'branch-normalized', confidence: 'medium' },
  ]
  for (const stage of stages) {
    const picked = pickCandidates(collect(stage.map, stage.keys))
    if (picked.kind === 'miss') continue
    if (picked.kind === 'ambiguous') return picked
    return { kind: 'hit', face: faceOf(picked.candidate, stage.via, stage.confidence) }
  }
  return { kind: 'miss' }
}

function lookupModel(branch, model) {
  const direct = lookupBranch(branch, model)
  if (direct.kind !== 'miss') return direct
  const bare = bareModelOf(model)
  return bare === model ? direct : lookupBranch(branch, bare)
}

function indexCandidates(index, model) {
  const lower = lowerModelId(model)
  const exact = collect(index.byModel, [lower])
  if (exact.length > 0) return exact
  const bare = bareModelOf(lower)
  if (bare !== lower) {
    const bareExact = collect(index.byModel, [bare])
    if (bareExact.length > 0) return bareExact
  }
  const normalized = collect(index.byNormalized, [normalizeModelId(model)])
  if (normalized.length > 0) return normalized
  return bare === lower ? [] : collect(index.byNormalized, [normalizeModelId(bare)])
}

function labsOf(candidates) {
  const labs = new Set()
  for (const candidate of candidates) {
    if (candidate.lab !== undefined) labs.add(candidate.lab)
  }
  return labs
}

function labHint(model, labs) {
  const org = orgOf(model)
  if (org !== undefined && labs.has(org)) return org
  const vendor = familyVendorOf(model)
  return vendor !== undefined && labs.has(vendor) ? vendor : undefined
}

function routedBranch(book, provider) {
  const exact = book.index.branches.get(provider)
  if (exact !== undefined) return { branch: exact, aliased: false }
  const alias = modelsDevProviderOf(provider)
  if (alias === provider) return null
  const target = book.index.branches.get(alias)
  return target === undefined ? null : { branch: target, aliased: true }
}

function makerLookup(book, lab, model) {
  const branch = book.index.branches.get(lab)
  return branch === undefined ? { kind: 'miss' } : lookupModel(branch, model)
}

function priced(face) {
  return { kind: 'priced', face }
}

function unpriced(reason) {
  return { kind: 'unpriced', miss: { reason } }
}

function ambiguous(count) {
  return { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: count } }
}

const resolutionMemo = new WeakMap()

function basePriceResolutionOf(book, provider, model) {
  if (book === null || book === undefined) return unpriced('book-unavailable')
  const key = `${provider}\u0000${model}`
  let memo = resolutionMemo.get(book)
  if (memo === undefined) {
    memo = new Map()
    resolutionMemo.set(book, memo)
  }
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const resolution = resolvePriceOf(book, provider, model)
  memo.set(key, resolution)
  return resolution
}

function resolvePriceOf(book, provider, model) {
  const routed = routedBranch(book, provider)
  if (routed !== null) {
    const match = lookupModel(routed.branch, model)
    if (match.kind === 'hit') return priced(routed.aliased ? { ...match.face, via: 'provider-alias' } : match.face)
    if (match.kind === 'ambiguous') return ambiguous(match.count)
    if (!routed.branch.multiVendor) return unpriced('model-unknown')
  }
  const org = orgOf(model)
  if (org !== undefined) {
    const branch = book.index.branches.get(org)
    if (branch !== undefined) {
      const match = lookupBranch(branch, bareModelOf(model))
      if (match.kind === 'hit') return priced({ ...match.face, via: 'org-branch', confidence: 'high' })
      if (match.kind === 'ambiguous') return ambiguous(match.count)
    }
  }
  const candidates = indexCandidates(book.index, model)
  const labs = labsOf(candidates)
  if (labs.size === 1) {
    const lab = [...labs][0]
    const match = makerLookup(book, lab, model)
    if (match.kind === 'hit') return priced({ ...match.face, via: 'canonical-maker', confidence: 'high' })
    if (match.kind === 'ambiguous') return ambiguous(match.count)
  } else if (labs.size > 1) {
    const hint = labHint(model, labs)
    if (hint === undefined) return ambiguous(candidates.length)
    const match = makerLookup(book, hint, model)
    if (match.kind === 'hit') return priced({ ...match.face, via: 'canonical-maker', confidence: 'high' })
    return ambiguous(match.kind === 'ambiguous' ? match.count : candidates.length)
  } else {
    const vendor = familyVendorOf(model)
    if (vendor !== undefined) {
      const branch = book.index.branches.get(vendor)
      if (branch !== undefined) {
        const match = lookupModel(branch, model)
        if (match.kind === 'hit') return priced({ ...match.face, via: 'family', confidence: 'medium' })
        if (match.kind === 'ambiguous') return ambiguous(match.count)
      }
    }
  }
  const picked = pickCandidates(candidates)
  if (picked.kind === 'hit') return priced(faceOf(picked.candidate, 'index', 'low'))
  if (picked.kind === 'ambiguous') return ambiguous(picked.count)
  return unpriced('no-entry')
}

function priceFaceOf(book, provider, model) {
  const resolution = priceResolutionOf(book, provider, model)
  return resolution.kind === 'priced' ? resolution.face : null
}

function priceOf(book, provider, model) {
  return priceFaceOf(book, provider, model)?.rate ?? null
}

function branchOf(book, id) {
  const value = book[id]
  return value !== null && typeof value === 'object' ? value : null
}

export function pricesBookOf(value) {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return null
  const book = {}
  const canonicalOf = {}
  for (const providerId of Object.keys(data)) {
    if (providerId === '__proto__' || providerId === 'constructor' || providerId === 'prototype') continue
    const provider = asRecord(data[providerId])
    if (provider === null) continue
    const modelList = asRecord(provider.models)
    if (modelList === null) continue
    const models = {}
    for (const id of Object.keys(modelList)) {
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue
      const model = asRecord(modelList[id])
      const cost = model !== null ? asRecord(model.cost) : null
      if (cost === null) continue
      const miss = rateNum(cost.input)
      const out = rateNum(cost.output)
      if (miss === null || out === null) continue
      models[id] = {
        hit: rateNum(cost.cache_read) ?? miss,
        miss,
        write: rateNum(cost.cache_write) ?? miss,
        out,
      }
      const canonical = model?.['canonical_model_id']
      if (typeof canonical === 'string' && canonical.length > 0) {
        const branch = canonicalOf[providerId] ?? (canonicalOf[providerId] = {})
        branch[id] = canonical
      }
    }
    if (Object.keys(models).length > 0) book[providerId] = models
  }
  return { prices: book, index: priceIndexOf(book, canonicalOf) }
}

function rateNum(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export const PRICE_SOURCE = 'https://models.dev/api.json'
export const PRICE_TTL_MS = 60 * 60 * 1000
export const PRICE_FAILURE_BACKOFF_MS = 30_000
export const PRICE_TIMEOUT_MS = 8_000

/** The provider prefix is stripped only when it is the supplied source provider. */
export function normalizeSourceIdentity(provider, model) {
  const pid = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
  const raw = typeof model === 'string' ? model.trim() : ''
  const prefix = `${pid}/`
  const mid = pid && raw.toLowerCase().startsWith(prefix) ? raw.slice(prefix.length) : raw
  return { provider: pid, model: mid }
}

export function priceResolutionOf(book, provider, model) {
  const identity = normalizeSourceIdentity(provider, model)
  // Some DSH gateways retain workbuddy/ inside model while their provider is
  // magpie. Only this explicit route/model pair opts into the user policy.
  const routeModel = lowerModelId(identity.model)
  const workbuddyPrefix = routeModel.startsWith('workbuddy/')
  const referenceModel = workbuddyPrefix ? routeModel.slice('workbuddy/'.length) : routeModel
  const workbuddyFlash = (identity.provider === 'workbuddy' || workbuddyPrefix)
    && referenceModel.replace(/[._]/g, '-') === 'deepseek-v4-1-flash'
  if (workbuddyFlash) {
    const official = basePriceResolutionOf(book, 'deepseek', 'deepseek-v4-flash')
    if (official.kind !== 'priced') return official
    return { kind: 'priced', face: { ...official.face, via: 'user-override', confidence: 'high', peakPolicy: 'deepseek-official' } }
  }
  return basePriceResolutionOf(book, identity.provider, identity.model)
}

/** A catalog belongs to one plugin activation; it is never persisted globally. */
export function createPricingCatalog(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const now = options.now || Date.now
  const ttlMs = options.ttlMs ?? PRICE_TTL_MS
  const failureBackoffMs = options.failureBackoffMs ?? PRICE_FAILURE_BACKOFF_MS
  const timeoutMs = options.timeoutMs ?? PRICE_TIMEOUT_MS
  let book = null
  let fetchedAt = null
  let version = 0
  let failed = false
  let retryAt = 0
  let inflight = null
  let controller = null
  let disposed = false

  const snapshot = () => ({
    book,
    version,
    source: PRICE_SOURCE,
    fetchedAt,
    stale: book !== null && (failed || fetchedAt === null || now() - fetchedAt >= ttlMs),
    retryAt,
  })

  async function refresh() {
    controller = new AbortController()
    let timer
    try {
      // Race explicitly: a custom fetcher might not implement AbortSignal.
      const next = await Promise.race([
        Promise.resolve().then(async () => {
          const response = await fetchImpl(PRICE_SOURCE, {
            headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 TokenReceipt/1.0 (+https://github.com/maxlee/dsh-token-receipt)' },
            signal: controller.signal,
          })
          if (!response || !response.ok) throw new Error(`Model price request failed (${response?.status ?? 'no response'})`)
          return pricesBookOf(await response.json())
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller?.abort(); reject(new Error('Model price request timed out')) }, timeoutMs)
        }),
      ])
      if (next === null || next.index.branches.size === 0) throw new Error('Model price catalog contains no usable rates')
      if (disposed) return
      book = next
      fetchedAt = now()
      version += 1
      failed = false
      retryAt = 0
    } catch {
      if (disposed) return
      failed = true
      retryAt = now() + failureBackoffMs
    } finally {
      clearTimeout(timer)
      controller = null
    }
  }

  return {
    async read() {
      if (disposed) return snapshot()
      if (inflight !== null) { await inflight; return snapshot() }
      const fresh = book !== null && fetchedAt !== null && now() - fetchedAt < ttlMs
      if ((!fresh || failed) && now() >= retryAt) {
        inflight = refresh()
        try { await inflight } finally { inflight = null }
      }
      return snapshot()
    },
    snapshot,
    dispose() { disposed = true; controller?.abort(); book = null },
  }
}

export function isBeijingPeak(time) {
  if (!Number.isFinite(time)) return false
  const date = new Date(time + 8 * 60 * 60 * 1000)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

const zeroBreakdown = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
const tokenNumber = (value) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0

export function priceMessage(message, snapshot) {
  const resolution = priceResolutionOf(snapshot.book, message.provider, message.model)
  if (resolution.kind !== 'priced') return { priced: false, miss: resolution.miss }
  const identity = normalizeSourceIdentity(message.provider, message.model)
  const face = resolution.face
  const peakPolicy = face.peakPolicy || (isDeepSeekProvider(identity.provider) ? 'deepseek-official' : 'flat')
  const peak = peakPolicy === 'deepseek-official' && isBeijingPeak(message.time)
  const multiplier = peak ? 2 : 1
  const factor = multiplier / 1e6
  return {
    priced: true,
    face,
    peakPolicy,
    peak,
    multiplier,
    breakdown: {
      input: tokenNumber(message.input) * face.rate.miss * factor,
      cacheRead: tokenNumber(message.cacheRead) * face.rate.hit * factor,
      cacheWrite: tokenNumber(message.cacheWrite) * face.rate.write * factor,
      output: tokenNumber(message.output) * face.rate.out * factor,
    },
  }
}

/** Amounts are USD, not tokens; missing models remain distinguishable from $0. */
export function createPricingAccumulator(snapshot) {
  const breakdown = zeroBreakdown()
  const missing = new Map()
  const fallbacks = new Map()
  let pricedRequests = 0
  let unpricedRequests = 0
  return {
    add(message, priced = priceMessage(message, snapshot)) {
      const identity = { provider: message.provider || '', model: message.model || 'unknown' }
      if (!priced.priced) {
        unpricedRequests += 1
        const key = `${identity.provider}\u0000${identity.model}\u0000${priced.miss.reason}`
        const entry = missing.get(key) || { ...identity, ...priced.miss, requests: 0 }
        entry.requests += 1
        missing.set(key, entry)
        return priced
      }
      pricedRequests += 1
      for (const field of Object.keys(breakdown)) breakdown[field] += priced.breakdown[field]
      if (priced.face.via !== 'direct') {
        const key = `${identity.provider}\u0000${identity.model}\u0000${priced.face.pid}\u0000${priced.face.mid}`
        const entry = fallbacks.get(key) || {
          ...identity,
          priceProvider: priced.face.pid,
          priceModel: priced.face.mid,
          via: priced.face.via,
          confidence: priced.face.confidence,
          peakPolicy: priced.peakPolicy,
          requests: 0,
        }
        entry.requests += 1
        fallbacks.set(key, entry)
      }
      return priced
    },
    result() {
      const complete = unpricedRequests === 0
      const sum = Object.values(breakdown).reduce((a, b) => a + b, 0)
      return {
        totalUsd: complete || pricedRequests > 0 ? sum : null,
        complete,
        status: complete ? 'complete' : pricedRequests > 0 ? 'partial' : 'unavailable',
        source: snapshot.source || PRICE_SOURCE,
        fetchedAt: snapshot.fetchedAt ?? null,
        stale: Boolean(snapshot.stale),
        pricedRequests,
        unpricedRequests,
        breakdown: { ...breakdown },
        missing: [...missing.values()],
        fallbacks: [...fallbacks.values()],
      }
    },
  }
}

