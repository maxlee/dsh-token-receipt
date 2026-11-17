import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function depsSame(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false
  return true
}

function createMiniReact() {
  let currentInstance = null
  let hookIndex = 0
  const Fragment = Symbol('Fragment')

  function createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true)
    return {
      type,
      props: {
        ...(props || {}),
        children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat,
      },
    }
  }

  const React = {
    Fragment,
    createElement,
    useState(initial) {
      const inst = currentInstance
      const idx = hookIndex++
      if (!(idx in inst.hooks)) {
        inst.hooks[idx] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (updater) => {
        if (inst.unmounted) return
        const prev = inst.hooks[idx]
        const next = typeof updater === 'function' ? updater(prev) : updater
        if (!Object.is(prev, next)) {
          inst.hooks[idx] = next
          inst.rerenderCount += 1
          inst.render()
        }
      }
      return [inst.hooks[idx], setState]
    },
    useRef(initial) {
      const inst = currentInstance
      const idx = hookIndex++
      if (!(idx in inst.hooks)) inst.hooks[idx] = { current: initial }
      return inst.hooks[idx]
    },
    useMemo(factory, deps) {
      const inst = currentInstance
      const idx = hookIndex++
      const prev = inst.hooks[idx]
      if (!prev || !depsSame(prev.deps, deps)) {
        inst.hooks[idx] = { value: factory(), deps }
      }
      return inst.hooks[idx].value
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps)
    },
    useEffect(effect, deps) {
      const inst = currentInstance
      const idx = hookIndex++
      const prev = inst.hooks[idx]
      if (!prev || !depsSame(prev.deps, deps)) {
        inst.pendingEffects.push(() => {
          if (prev && typeof prev.cleanup === 'function') prev.cleanup()
          const cleanup = effect()
          inst.hooks[idx] = { deps, cleanup }
        })
      }
    },
  }

  function expand(node) {
    if (node === null || node === undefined || typeof node === 'boolean') return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(expand).flat(Infinity).filter((x) => x !== null)
    if (typeof node.type === 'function') return expand(node.type(node.props || {}))
    const rawChildren = node.props?.children
    const childList = rawChildren === undefined ? [] : Array.isArray(rawChildren) ? rawChildren : [rawChildren]
    const expandedChildren = childList.map(expand).flat(Infinity).filter((x) => x !== null)
    if (node.type === Fragment) return expandedChildren
    const element = { type: node.type, props: node.props || {}, children: expandedChildren }
    if (element.props.ref && typeof element.props.ref === 'object' && 'current' in element.props.ref && !element.props.ref.current) {
      element.props.ref.current = element
    }
    return element
  }

  function mount(Component, props) {
    const inst = {
      hooks: [],
      pendingEffects: [],
      tree: null,
      rerenderCount: 0,
      isRendering: false,
      needsRender: false,
      unmounted: false,
      setProps(nextProps) {
        props = nextProps
        inst.render()
      },
      render() {
        if (inst.unmounted) return inst.tree
        if (inst.isRendering) {
          inst.needsRender = true
          return inst.tree
        }
        inst.isRendering = true
        try {
          do {
            inst.needsRender = false
            currentInstance = inst
            hookIndex = 0
            const vnode = Component(props)
            currentInstance = null
            inst.tree = expand(vnode)
            const effects = inst.pendingEffects.splice(0)
            for (const run of effects) run()
          } while (inst.needsRender && !inst.unmounted)
        } finally {
          inst.isRendering = false
        }
        return inst.tree
      },
      unmount() {
        inst.unmounted = true
        for (const hook of inst.hooks) {
          if (hook && typeof hook.cleanup === 'function') {
            hook.cleanup()
            hook.cleanup = null
          }
        }
      },
    }
    inst.render()
    return inst
  }

  return { React, mount, expand }
}

function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  if (Array.isArray(node.children)) {
    for (const child of node.children) findAll(child, predicate, out)
  }
  return out
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return (node.children || []).map(textOf).join('')
}

// Exercise pure helpers, dictionaries, export logic, and Panel/apply behavior from client.js.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const exportLine = "return { inject: ['slots', 'locale'], apply }"
assert.ok(source.includes(exportLine), 'client factory export must be discoverable')

const { React, mount, expand } = createMiniReact()
let definition
let reducedMotion = false
let nextTimerId = 1
const timers = new Map()
const headChildren = []
const bodyChildren = []

const env = {
  fetchImpl: async () => {
    throw new Error('Unexpected fetch')
  },
  createRangeImpl: null,
  createElementImpl: null,
  getComputedStyleImpl: () => ({ opacity: '1', color: '#111', backgroundColor: '#fff' }),
  path2DCalls: [],
  revokedUrls: [],
}

const fonts = { ready: Promise.resolve() }
const windowObj = {
  __ModuleLoader__: { load(value) { definition = value } },
  matchMedia(query) {
    if (query === '(prefers-reduced-motion: reduce)') return { matches: reducedMotion }
    return { matches: false }
  },
  print() {},
  navigator: undefined,
  ClipboardItem: undefined,
}

const documentObj = {
  fonts,
  head: {
    children: headChildren,
    appendChild(el) {
      el.parentNode = documentObj.head
      el.remove = () => {
        const idx = headChildren.indexOf(el)
        if (idx >= 0) headChildren.splice(idx, 1)
        el.parentNode = null
      }
      headChildren.push(el)
      return el
    },
  },
  body: {
    children: bodyChildren,
    appendChild(el) {
      el.remove = () => {
        const idx = bodyChildren.indexOf(el)
        if (idx >= 0) bodyChildren.splice(idx, 1)
      }
      bodyChildren.push(el)
      return el
    },
  },
  getElementById(id) {
    return headChildren.find((el) => el.id === id) || null
  },
  createElement(tag) {
    if (env.createElementImpl) return env.createElementImpl(tag)
    return { tagName: tag.toUpperCase(), style: {}, click() {}, remove() {} }
  },
  createRange() {
    if (env.createRangeImpl) return env.createRangeImpl()
    throw new Error('Unexpected createRange')
  },
  createTreeWalker(root) {
    const nodes = root._textNodes ? [...root._textNodes] : []
    let idx = 0
    return {
      nextNode() {
        return idx < nodes.length ? nodes[idx++] : null
      },
    }
  },
}

class MockPath2D {
  constructor(d) {
    this.d = d
    env.path2DCalls.push(d)
  }
}

vm.runInNewContext(
  source.replace(
    exportLine,
    `return {
      inject: ['slots', 'locale'],
      apply,
      normalizeLocale,
      translatedCopy,
      startOfDay,
      startOfMonth,
      dateKey,
      monthKey,
      parseDateKey,
      parseMonthKey,
      fullDate,
      shortDate,
      monthYear,
      PERIODS,
      isSteppablePeriod,
      periodRange,
      periodKey,
      periodLabel,
      relativeLabel,
      billNumber,
      fmtExact,
      defaultCurrencyForLocale,
      resolveCurrencyPreference,
      fmtMoney,
      DISPLAY_RATES,
      JPY_RATE_DATE,
      DICT,
      FONT_CSS,
      CSS,
      collectWrappedLines,
      renderReceiptPngBlob,
      exportReceiptPng,
      copyReceiptPng,
      CheckCircle,
      CopyIcon,
      Receipt,
      Panel,
    }`,
  ),
  {
    window: windowObj,
    document: documentObj,
    NodeFilter: { SHOW_TEXT: 4 },
    Path2D: MockPath2D,
    AbortController,
    Intl,
    Date,
    Math,
    URL: {
      createObjectURL: () => 'blob:mock-receipt',
      revokeObjectURL: (url) => env.revokedUrls.push(url),
    },
    getComputedStyle: (el) => env.getComputedStyleImpl(el),
    fetch: (...args) => env.fetchImpl(...args),
    setTimeout(fn, ms) {
      const id = nextTimerId++
      timers.set(id, { id, fn, ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    console: { error() {}, warn() {}, log() {} },
  },
)

const client = definition.factory((name) => {
  assert.equal(name, 'react')
  return React
})

const {
  apply,
  normalizeLocale,
  translatedCopy,
  startOfDay,
  dateKey,
  monthKey,
  parseDateKey,
  parseMonthKey,
  fullDate,
  shortDate,
  monthYear,
  PERIODS,
  isSteppablePeriod,
  periodRange,
  periodKey,
  periodLabel,
  relativeLabel,
  billNumber,
  fmtExact,
  defaultCurrencyForLocale,
  resolveCurrencyPreference,
  fmtMoney,
  DISPLAY_RATES,
  JPY_RATE_DATE,
  DICT,
  FONT_CSS,
  CSS,
  collectWrappedLines,
  renderReceiptPngBlob,
  exportReceiptPng,
  copyReceiptPng,
  CheckCircle,
  CopyIcon,
  Receipt,
  Panel,
} = client

async function flushMicrotasks(turns = 6) {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

function runTimerMatching(predicate, label) {
  const entry = [...timers.values()].find((item) => predicate(item.ms))
  assert.ok(entry, `Expected timer (${label}); active: ${[...timers.values()].map((t) => t.ms).join(', ')}`)
  timers.delete(entry.id)
  entry.fn()
}

function createMockCtx(initialLocale = 'en') {
  let active = initialLocale
  const listeners = new Set()
  const effects = []
  const slots = {}
  return {
    effects,
    slots,
    setLocale(next) {
      active = next
      for (const listener of listeners) listener()
    },
    effect(fn, label) {
      const cleanup = fn()
      effects.push({ label, cleanup })
    },
    locale: {
      getSnapshot: () => ({ active, locales: [{ id: 'en' }, { id: 'zh' }] }),
      subscribe(fn) {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
      addLanguage() {
        return () => {}
      },
      register() {
        return () => {}
      },
      bind(ns) {
        return (key) => {
          if (Object.hasOwn(DICT, active)) return DICT[active][key]
          return `${ns}.${key}`
        }
      },
    },
    slots: {
      inject(name, fn) {
        slots[name] = fn()
      },
      register(meta, render) {
        return { meta, render }
      },
    },
  }
}

function sampleBill(overrides = {}) {
  const now = new Date()
  const start = startOfDay(now)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  return {
    ok: true,
    period: 'day',
    date: dateKey(start),
    from: start.getTime(),
    to: end.getTime(),
    generatedAt: now.getTime(),
    totals: {
      inputTokens: 1200,
      outputTokens: 800,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 2000,
      requests: 3,
      sessions: 1,
    },
    pricing: {
      status: 'complete',
      stale: false,
      unpricedRequests: 0,
      totalUsd: 1.5,
      breakdown: { input: 0.5, output: 1.0, cacheRead: 0, cacheWrite: 0 },
    },
    models: [
      {
        model: 'deepseek/deepseek-chat',
        total: 2000,
        requests: 3,
        pricing: { totalUsd: 1.5, complete: true },
      },
    ],
    ...overrides,
  }
}

test('automatic currency follows Chinese, English and Japanese including regional tags', () => {
  for (const language of ['zh', 'zh-CN', 'zh-TW', 'ZH_hans']) assert.equal(defaultCurrencyForLocale(language), 'cny')
  for (const language of ['ja', 'ja-JP']) assert.equal(defaultCurrencyForLocale(language), 'jpy')
  for (const language of ['en', 'en-US', 'de', '', undefined]) assert.equal(defaultCurrencyForLocale(language), 'usd')
})

test('manual currency is retained across language changes; auto restores language defaults', () => {
  for (const locale of ['zh', 'en', 'ja']) {
    for (const chosen of ['usd', 'cny', 'jpy']) assert.equal(resolveCurrencyPreference(chosen, locale), chosen)
  }
  assert.equal(resolveCurrencyPreference('auto', 'zh'), 'cny')
  assert.equal(resolveCurrencyPreference('auto', 'en'), 'usd')
  assert.equal(resolveCurrencyPreference('auto', 'ja'), 'jpy')
  assert.equal(resolveCurrencyPreference('invalid', 'ja'), 'jpy')
})

test('amounts convert from USD instead of only changing the currency symbol', () => {
  assert.equal(DISPLAY_RATES.usd, 1)
  assert.equal(DISPLAY_RATES.cny, 1 / 0.15)
  assert.equal(DISPLAY_RATES.jpy, 160)
  assert.equal(JPY_RATE_DATE, '2026-11-13')
  assert.equal(fmtMoney(1, 'usd'), '$1.00')
  assert.equal(fmtMoney(0.15, 'cny'), '¥1.00')
  assert.equal(fmtMoney(1, 'jpy'), '¥160')
  assert.equal(fmtMoney(10, 'jpy'), '¥1,600')
  assert.equal(fmtMoney(0.003, 'jpy'), '¥0.48')
})

test('free, unpriced and tiny positive charges stay distinct in every currency', () => {
  for (const currency of ['usd', 'cny', 'jpy']) {
    assert.equal(fmtMoney(null, currency), '—')
    assert.equal(fmtMoney(NaN, currency), '—')
    assert.equal(fmtMoney(Infinity, currency), '—')
    assert.ok(fmtMoney(0.000000000001, currency).startsWith('<'))
  }
  assert.equal(fmtMoney(0, 'usd'), '$0.00')
  assert.equal(fmtMoney(0, 'cny'), '¥0.00')
  assert.equal(fmtMoney(0, 'jpy'), '¥0')
})

test('PNG export aborts before rendering if language, currency, or connection changes while awaiting fonts', async () => {
  for (const change of ['language', 'currency', 'disconnect']) {
    let ready
    fonts.ready = new Promise((resolve) => { ready = resolve })
    const paper = {
      lang: 'zh', dataset: { currency: 'cny' }, isConnected: true,
      getBoundingClientRect() { throw new Error('Export should have stopped before reading layout') },
    }
    const exporting = exportReceiptPng(paper, 'test')
    if (change === 'language') paper.lang = 'ja'
    else if (change === 'currency') paper.dataset.currency = 'jpy'
    else paper.isConnected = false
    ready()
    await assert.rejects(exporting, change === 'disconnect' ? /Receipt was closed/ : /language or currency changed/)
  }
  fonts.ready = Promise.resolve()
})

test('all three language dictionaries include matching keys and sorted placeholders with dead keys removed', () => {
  const keys = Object.keys(DICT.en).sort()
  const removedKeys = ['daily', 'weekly', 'monthly', 'printPaper', 'total', 'models', 'emptyHint', 'referencePrice', 'fallbackPrice', 'priceAsOf']
  for (const dead of removedKeys) {
    assert.equal(Object.hasOwn(DICT.en, dead), false, `dead key ${dead} should be removed`)
  }
  for (const required of ['copyImage', 'copyingImage', 'copiedImage', 'copyFailed', 'clipboardUnsupported', 'days30', 'days90', 'all', 'allTime']) {
    assert.equal(Object.hasOwn(DICT.en, required), true, `missing required key ${required}`)
  }
  assert.match(DICT.en.exportChanged, /language or currency changed/)
  assert.equal(DICT.en.completeStatus, 'Receipt complete')
  for (const language of ['zh', 'ja']) {
    assert.deepEqual(Object.keys(DICT[language]).sort(), keys)
    for (const key of keys) {
      assert.ok(DICT[language][key].trim())
      const actualPlaceholders = (DICT[language][key].match(/\{[^}]+\}/g) || []).slice().sort()
      const expectedPlaceholders = (DICT.en[key].match(/\{[^}]+\}/g) || []).slice().sort()
      assert.deepEqual(actualPlaceholders, expectedPlaceholders, `placeholder mismatch on ${language}.${key}`)
    }
  }
  assert.ok(DICT.ja.autoCurrency)
  assert.ok(DICT.ja.exchangeRateJpy.includes('{rate}'))
  assert.ok(DICT.ja.exchangeRateJpy.includes('{date}'))
})

test('regional locale subtags normalize consistently across locale, copy fallback, dates, numbers, and sidebar label', () => {
  for (const tag of ['zh', 'zh-CN', 'zh-TW', 'ZH_hans']) assert.equal(normalizeLocale(tag), 'zh')
  for (const tag of ['ja', 'ja-JP', 'JA_JP']) assert.equal(normalizeLocale(tag), 'ja')
  for (const tag of ['en', 'en-US', 'fr-FR', '', null, undefined]) assert.equal(normalizeLocale(tag), 'en')

  const start = new Date(2026, 10, 9)
  const end = new Date(2026, 10, 16)
  assert.equal(fullDate(start, 'zh-CN'), '2026年11月9日')
  assert.equal(fullDate(start, 'ja-JP'), '2026年11月9日')
  assert.equal(shortDate(start, 'zh-CN'), '11月9日')
  assert.equal(monthYear(start, 'ja-JP'), '2026年11月')
  assert.equal(periodLabel('week', start, end, 'zh-CN'), '2026年11月9日 – 11月15日')
  assert.equal(periodLabel('week', start, end, 'ja-JP'), '2026年11月9日〜11月15日')
  assert.equal(fmtExact(1234567, 'zh-CN'), fmtExact(1234567, 'zh'))
  assert.equal(fmtExact(1234567, 'ja-JP'), fmtExact(1234567, 'ja'))

  // Guard `${NS}.${key}` and regional active fallback in translatedCopy.
  const zhCtx = createMockCtx('zh-CN')
  const zhCopy = translatedCopy(zhCtx)
  assert.equal(zhCopy.title, DICT.zh.title)
  assert.equal(zhCopy.completeStatus, DICT.zh.completeStatus)

  const englishFallbackCtx = {
    locale: {
      getSnapshot: () => ({ active: 'ja-JP', locales: [] }),
      bind: () => (key) => DICT.en[key],
    },
  }
  assert.equal(translatedCopy(englishFallbackCtx).title, DICT.ja.title)
})

test('apply injects scoped font-face CSS once, removes it on dispose, and normalizes sidebar label', () => {
  headChildren.length = 0
  assert.ok(FONT_CSS.includes("font-family: 'TokenReceiptInter'"))
  assert.ok(FONT_CSS.includes("font-family: 'TokenReceiptMono'"))
  assert.equal(FONT_CSS.includes("font-family: 'Inter'"), false)
  assert.equal(FONT_CSS.includes("font-family: 'JetBrains Mono'"), false)
  assert.equal(CSS.includes('@font-face'), false)
  assert.ok(CSS.includes('body:has(.tr-page) *'))
  assert.ok(CSS.includes('print-color-adjust: exact'))
  assert.ok(CSS.includes('.tr-periods { display: inline-flex; flex-wrap: wrap;'))
  assert.ok(CSS.includes('.tr-datebox.is-static {'))
  assert.ok(CSS.includes('.tr-datebox:not(.is-static):hover'))
  assert.equal(CSS.includes('--dsw-alias-'), false)

  const ctx = createMockCtx('zh-CN')
  let sidebarLabelFn
  ctx.slots = {
    inject(name, fn) {
      fn()
    },
    register(meta) {
      if (meta.name === 'sidebar.panellist') sidebarLabelFn = meta.label
      return () => {}
    },
  }
  apply(ctx)
  assert.equal(headChildren.length, 1)
  assert.equal(headChildren[0].id, 'dsh-token-receipt-fonts')
  assert.equal(sidebarLabelFn(), DICT.zh.nav)
  ctx.setLocale('ja-JP')
  assert.equal(sidebarLabelFn(), DICT.ja.nav)
  ctx.setLocale('en-GB')
  assert.equal(sidebarLabelFn(), DICT.en.nav)

  for (const effect of ctx.effects) effect.cleanup?.()
  assert.equal(headChildren.length, 0)
})

test('parseDateKey and parseMonthKey enforce strict format, reject calendar rollover, and clamp future dates to today', () => {
  const fixedNow = new Date(2026, 10, 14, 15, 30, 0)
  const fixedToday = startOfDay(fixedNow)

  for (const invalid of ['', '2026', '2026-11', '2-11-14', '26-11-14', '0002-11-14', '2026-1-14', '2026-11-4', '2026-00-10', '2026-13-01', '2026-02-29', '2026-02-31', '2026-04-31', '2099-02-30', '2026-11-14-01']) {
    assert.equal(parseDateKey(invalid, fixedNow), null, `expected parseDateKey(${invalid}) to be null`)
  }
  assert.equal(dateKey(parseDateKey('2024-02-29', fixedNow)), '2024-02-29')
  assert.equal(dateKey(parseDateKey('2026-11-01', fixedNow)), '2026-11-01')
  assert.equal(parseDateKey('2026-12-25', fixedNow).getTime(), fixedToday.getTime())
  assert.equal(parseDateKey('2099-01-01', fixedNow).getTime(), fixedToday.getTime())

  for (const invalidMonth of ['', '2026', '26-11', '0002-11', '2026-1', '2026-00', '2026-13', '2026-11-01']) {
    assert.equal(parseMonthKey(invalidMonth, fixedNow), null, `expected parseMonthKey(${invalidMonth}) to be null`)
  }
  assert.equal(monthKey(parseMonthKey('2026-11', fixedNow)), '2026-11')
  assert.equal(monthKey(parseMonthKey('2025-02', fixedNow)), '2025-02')
  assert.equal(parseMonthKey('2026-12', fixedNow).getTime(), fixedToday.getTime())
  assert.equal(parseMonthKey('2099-05', fixedNow).getTime(), fixedToday.getTime())
})

test('Receipt guards invalid generatedAt and uses lowercase requests on model detail rows', () => {
  const bill = sampleBill({ generatedAt: 'invalid-date' })
  const tree = expand(React.createElement(Receipt, {
    copy: DICT.en,
    locale: 'en-US',
    data: bill,
    period: 'day',
    currency: 'auto',
  }))
  const details = findAll(tree, (n) => n.props?.className === 'tr-item-detail')
  assert.equal(details.length, 1)
  assert.equal(textOf(details[0]), '2,000 tokens · 3 requests')

  const dds = findAll(tree, (n) => n.type === 'dd').map(textOf)
  assert.equal(dds.some((val) => val.includes('NaN')), false)
  assert.ok(dds.includes('—'))
})

test('collectWrappedLines and exportReceiptPng handle mixed CJK + ASCII offsets, surrogate pairs, localized errors, and post-toBlob disconnect', async () => {
  // Simulate mixed CJK (top: 100..110) and ASCII mono (top: 102.4..109.4) on line 1, plus emoji surrogate pair, wrapping to line 2 at top: 112..122.
  const lineOneText = '人民币 1 USD🧮'
  const lineTwoText = '≈ 6.67 CNY'
  const raw = `${lineOneText} ${lineTwoText}`
  const lineBreakOffset = lineOneText.length
  env.createRangeImpl = () => {
    let start = 0
    let end = 0
    return {
      setStart(_node, s) { start = s },
      setEnd(_node, e) { end = e },
      getBoundingClientRect() {
        if (start === lineBreakOffset) return { top: 100, bottom: 110, height: 10, width: 0 } // collapsed wrap space
        const isSecondLine = start > lineBreakOffset
        const slice = raw.slice(start, end)
        const isAscii = /^[\x20-\x7e]+$/.test(slice)
        const baseTop = isSecondLine ? 112 : 100
        return isAscii
          ? { top: baseTop + 2.4, bottom: baseTop + 9.4, height: 7, width: 6 }
          : { top: baseTop, bottom: baseTop + 10, height: 10, width: 10 }
      },
    }
  }
  const lines = collectWrappedLines({ nodeValue: raw }, 12)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].text, lineOneText)
  assert.equal(lines[1].text, lineTwoText)
  env.createRangeImpl = null

  // Localized error messages when copy is provided.
  await assert.rejects(exportReceiptPng(null, 'TR-1', DICT.zh), new RegExp(DICT.zh.exportNotReady))

  // Null 2d context guard with localized Japanese copy.
  env.createElementImpl = (tag) => {
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => null }
    return { style: {}, click() {}, remove() {} }
  }
  const stubPaper = {
    lang: 'ja',
    dataset: { currency: 'jpy' },
    isConnected: true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }),
  }
  await assert.rejects(exportReceiptPng(stubPaper, 'TR-1', DICT.ja), new RegExp(DICT.ja.exportFailed))

  // Vector Path2D logo + post-toBlob disconnect check prevents download after unmount.
  env.path2DCalls.length = 0
  let clickedDownload = false
  let pendingBlobCallback = null
  const fillAlphas = []
  const mockCtx2d = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'middle',
    scale() {},
    translate() {},
    save() {},
    restore() { this.globalAlpha = 1 },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    clip() {},
    setLineDash() {},
    stroke() {},
    fillRect() { fillAlphas.push(this.globalAlpha) },
    fill() { fillAlphas.push(this.globalAlpha) },
    fillText() {},
    measureText: (t) => ({ width: t.length * 5 }),
  }
  env.createElementImpl = (tag) => {
    if (tag === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => mockCtx2d,
        toBlob(cb) { pendingBlobCallback = cb },
      }
    }
    return {
      style: {},
      click() { clickedDownload = true },
      remove() {},
    }
  }
  env.getComputedStyleImpl = (el) => {
    if (el._role === 'logo') return { color: '#111', opacity: '0.9' }
    if (el._role === 'barcode') return { color: '#111', opacity: '0.85' }
    return { backgroundColor: '#fcfcfc', color: '#111', opacity: '1' }
  }
  const fullPaper = {
    lang: 'zh',
    dataset: { currency: 'cny' },
    isConnected: true,
    _textNodes: [],
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 300, height: 400 }),
    querySelector(sel) {
      if (sel === '.tr-paper-logo') return { _role: 'logo', getBoundingClientRect: () => ({ left: 140, top: 48, width: 40, height: 40 }) }
      if (sel === '.tr-barcode') return { _role: 'barcode', getBoundingClientRect: () => ({ left: 96, top: 360, right: 224, width: 128, height: 28 }) }
      return null
    },
    querySelectorAll: () => [],
  }
  const pendingExport = exportReceiptPng(fullPaper, 'TR-D-TEST', DICT.zh)
  await flushMicrotasks()
  assert.equal(env.path2DCalls.length, 1)
  assert.ok(fillAlphas.includes(0.9), 'logo opacity should be applied')
  assert.ok(fillAlphas.includes(0.85), 'barcode opacity should be applied')
  assert.equal(typeof pendingBlobCallback, 'function')

  // Disconnect receipt while toBlob is in flight.
  fullPaper.isConnected = false
  pendingBlobCallback({ size: 128 })
  await assert.rejects(pendingExport, new RegExp(DICT.zh.exportClosed))
  assert.equal(clickedDownload, false, 'must not trigger download if receipt disconnected during toBlob')
  env.createElementImpl = null
})

test('Panel keeps period, date, and currency unlocked during print animation, updates currency live, aborts on period change, and passes refresh=1 on priceRetry', async () => {
  timers.clear()
  reducedMotion = false
  const fetchedUrls = []
  const signals = []
  let nextBill = sampleBill()

  env.fetchImpl = async (url, options = {}) => {
    fetchedUrls.push(url)
    signals.push(options.signal)
    return {
      ok: true,
      status: 200,
      json: async () => nextBill,
    }
  }

  const ctx = createMockCtx('en')
  const view = mount(Panel, { ctx })
  await flushMicrotasks()

  // Initial mount waits MIN_PROCESSING_MS (<= 850ms) before entering 'printing'.
  assert.equal(fetchedUrls.length, 1)
  assert.equal(fetchedUrls[0].includes('refresh=1'), false)
  runTimerMatching((ms) => ms > 0 && ms <= 850, 'MIN_PROCESSING_MS')
  await flushMicrotasks()

  // Now in stage === 'printing' (1900ms feed timer pending).
  const paperWrap = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0]
  assert.equal(paperWrap.props['data-stage'], 'printing')
  const firstRunKey = paperWrap.props.key

  // Replay Print, Save PNG, and Copy image stay disabled while printing, and Print / PDF is gone; period/date/currency controls are UNLOCKED!
  const allButtonsWhilePrinting = findAll(view.tree, (n) => n.type === 'button')
  assert.equal(allButtonsWhilePrinting.some((b) => textOf(b) === 'Print / PDF' || textOf(b) === '打印 / PDF'), false)
  const copyBtn = allButtonsWhilePrinting.find((b) => textOf(b) === DICT.en.copyImage)
  assert.ok(copyBtn, 'Copy image button should replace Print / PDF')
  assert.equal(copyBtn.props.disabled, true)
  const replayBtn = findAll(view.tree, (n) => String(n.props?.className || '').includes('tr-btn-primary'))[0]
  assert.equal(replayBtn.props.disabled, true)

  const periodBtns = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))
  assert.equal(periodBtns.length, 6)
  for (const btn of periodBtns) assert.equal(btn.props.disabled, false, 'period buttons must stay unlocked while printing')

  const currencySelect = findAll(view.tree, (n) => n.type === 'select')[0]
  assert.equal(currencySelect.props.disabled, false, 'currency select must stay unlocked while printing')

  const dateInput = findAll(view.tree, (n) => n.props?.className === 'tr-datepicker')[0]
  assert.equal(dateInput.props.disabled, false, 'date input must stay unlocked while printing')

  let pickerShown = 0
  dateInput.props.onClick({
    currentTarget: {
      disabled: false,
      showPicker() { pickerShown += 1 },
    },
  })
  assert.equal(pickerShown, 1)

  // Swallows showPicker exceptions safely.
  assert.doesNotThrow(() => {
    dateInput.props.onClick({
      currentTarget: {
        disabled: false,
        showPicker() { throw new Error('NotAllowedError') },
      },
    })
  })

  // Switching currency while printing updates displayed cost immediately WITHOUT restarting animation or refetching!
  const screenTotalBefore = textOf(findAll(view.tree, (n) => n.props?.className === 'tr-screen-total')[0])
  assert.equal(screenTotalBefore, '$1.50')
  currencySelect.props.onChange({ target: { value: 'jpy' } })
  const screenTotalAfter = textOf(findAll(view.tree, (n) => n.props?.className === 'tr-screen-total')[0])
  assert.equal(screenTotalAfter, '¥240')
  assert.equal(fetchedUrls.length, 1, 'currency switch must not refetch')
  assert.equal(
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'],
    'printing',
    'currency switch must not interrupt printing animation',
  )

  // Clicking machine Today button when already on day + today is a no-op (no refetch).
  const machineTodayBtn = findAll(view.tree, (n) => n.props?.className === 'tr-machine-btn')[0]
  assert.equal(machineTodayBtn.props.disabled, false)
  machineTodayBtn.props.onClick()
  assert.equal(fetchedUrls.length, 1, 'clicking Today while already on Today must not refetch')

  // Switching period while printing aborts the first run, clears the 1900ms timer, fetches week, and replays the print animation!
  nextBill = sampleBill({
    period: 'week',
    pricing: {
      status: 'unavailable',
      stale: false,
      unpricedRequests: 3,
      totalUsd: null,
      breakdown: null,
    },
  })
  const weekBtn = periodBtns.find((btn) => textOf(btn) === DICT.en.week)
  weekBtn.props.onClick()
  await flushMicrotasks()

  assert.equal(signals[0].aborted, true, 'previous AbortController must be aborted when switching period')
  assert.equal([...timers.values()].some((t) => t.ms === 1900), false, '1900ms feed timer must be cleared')
  assert.equal(fetchedUrls.length, 2)
  assert.ok(fetchedUrls[1].includes('period=week'))
  assert.equal(fetchedUrls[1].includes('refresh=1'), false)
  assert.equal(
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'],
    'processing',
  )

  // Period switch schedules MIN_PROCESSING_MS (<= 850ms) -> printing (1900ms) -> complete.
  runTimerMatching((ms) => ms > 0 && ms <= 850, 'week MIN_PROCESSING_MS')
  await flushMicrotasks()
  const weekPrintingWrap = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0]
  assert.equal(weekPrintingWrap.props['data-stage'], 'printing')
  assert.notEqual(weekPrintingWrap.props.key, firstRunKey, 'printRunId key must increment to replay feed animation')

  runTimerMatching((ms) => ms === 1900, 'week printing feed')
  await flushMicrotasks()
  assert.equal(
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'],
    'complete',
  )

  // Week print completed; priceRetry button is visible and sends refresh=1 without re-animating.
  const priceRetryBtn = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.priceRetry)[0]
  assert.ok(priceRetryBtn, 'priceRetry button should render when pricing is unavailable')
  assert.equal(priceRetryBtn.props.disabled, false)

  nextBill = sampleBill({ period: 'week' })
  priceRetryBtn.props.onClick()
  await flushMicrotasks()
  assert.equal(fetchedUrls.length, 3)
  assert.ok(fetchedUrls[2].includes('&refresh=1'), 'priceRetry must append &refresh=1')
  assert.equal(timers.size, 0, 'priceRetry must not schedule print animation timers')

  // Dynamic prefers-reduced-motion skips MIN_PROCESSING_MS and 1900ms printing stage on Replay Print.
  reducedMotion = true
  const replayReadyBtn = findAll(view.tree, (n) => String(n.props?.className || '').includes('tr-btn-primary'))[0]
  assert.equal(replayReadyBtn.props.disabled, false)
  replayReadyBtn.props.onClick()
  await flushMicrotasks()
  assert.equal(fetchedUrls.length, 4)
  assert.equal(fetchedUrls[3].includes('refresh=1'), false)
  assert.equal(timers.size, 0, 'reduced motion should schedule no animation timers')
  assert.equal(
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'],
    'complete',
  )

  view.unmount()
  reducedMotion = false
  assert.equal(timers.size, 0)
})

test('Panel clears MIN_PROCESSING_MS timer on abort, replays animation on prevBtn, locks filters only during PNG save, and clears saveTimerRef on unmount', async () => {
  timers.clear()
  reducedMotion = false
  env.fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => sampleBill(),
  })

  const ctx = createMockCtx('zh-CN')
  const view = mount(Panel, { ctx })
  await flushMicrotasks()

  // Currently waiting on the <= 850ms MIN_PROCESSING_MS abort-aware timer.
  assert.equal([...timers.values()].some((t) => t.ms > 0 && t.ms <= 850), true)

  // Navigate to previous day while still in MIN_PROCESSING_MS — must clear the old timer immediately.
  const prevBtn = findAll(view.tree, (n) => n.props?.['aria-label'] === DICT.zh.prevPeriod)[0]
  assert.equal(prevBtn.props.disabled, false)
  prevBtn.props.onClick()
  assert.equal([...timers.values()].some((t) => t.ms > 0 && t.ms <= 850), false, 'aborting during MIN_PROCESSING_MS must clear its timer')
  await flushMicrotasks()

  // Navigating dates now replays the print animation: MIN_PROCESSING_MS (<= 850ms) -> printing (1900ms) -> complete.
  runTimerMatching((ms) => ms > 0 && ms <= 850, 'prevBtn MIN_PROCESSING_MS')
  await flushMicrotasks()
  assert.equal(
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'],
    'printing',
  )
  runTimerMatching((ms) => ms === 1900, 'prevBtn printing feed')
  await flushMicrotasks()
  assert.equal(
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'],
    'complete',
  )

  // Attach mock DOM paper node and trigger Save PNG.
  const articleNode = findAll(view.tree, (n) => n.type === 'article')[0]
  let pendingBlobCb = null
  env.createElementImpl = (tag) => {
    if (tag === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          globalAlpha: 1,
          scale() {},
          translate() {},
          save() {},
          restore() {},
          beginPath() {},
          moveTo() {},
          lineTo() {},
          closePath() {},
          clip() {},
          fillRect() {},
        }),
        toBlob(cb) { pendingBlobCb = cb },
      }
    }
    return { style: {}, click() {}, remove() {} }
  }
  articleNode.props.ref.current = {
    lang: 'zh',
    dataset: { currency: 'cny' },
    isConnected: true,
    _textNodes: [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }

  const saveBtn = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.zh.savePng)[0]
  assert.equal(saveBtn.props.disabled, false)
  const savePromise = saveBtn.props.onClick()
  await flushMicrotasks()

  // While saveState === 'saving', period, currency, date, and action controls are ALL locked!
  for (const btn of findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))) {
    assert.equal(btn.props.disabled, true, 'period buttons must lock during PNG export')
  }
  assert.equal(findAll(view.tree, (n) => n.type === 'select')[0].props.disabled, true, 'currency select must lock during PNG export')
  assert.equal(findAll(view.tree, (n) => n.props?.className === 'tr-datepicker')[0].props.disabled, true, 'date input must lock during PNG export')
  assert.equal(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.zh.copyImage)[0].props.disabled, true, 'copy button must lock during PNG export')

  // Finish PNG export -> schedules 3200ms saveTimerRef (plus 4000ms URL.revokeObjectURL).
  pendingBlobCb({ size: 64 })
  await savePromise
  assert.equal([...timers.values()].some((t) => t.ms === 3200), true, 'saved badge reset timer should be scheduled')

  // Unmounting Panel clears saveTimerRef cleanly.
  view.unmount()
  assert.equal([...timers.values()].some((t) => t.ms === 3200), false, 'unmounting Panel must clear saveTimerRef')
  timers.clear()
  env.createElementImpl = null
})

function setupCanvasStub(onToBlob) {
  const mockCtx2d = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'middle',
    scale() {},
    translate() {},
    save() {},
    restore() { this.globalAlpha = 1 },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    clip() {},
    setLineDash() {},
    stroke() {},
    fillRect() {},
    fill() {},
    fillText() {},
    measureText: (t) => ({ width: t.length * 5 }),
  }
  env.createElementImpl = (tag) => {
    if (tag === 'canvas') {
      return {
        width: 0,
        height: 0,
        getContext: () => mockCtx2d,
        toBlob(cb) { onToBlob(cb) },
      }
    }
    return { style: {}, click() {}, remove() {} }
  }
}

function makePaperStub(lang = 'en', currency = 'usd') {
  return {
    lang,
    dataset: { currency },
    isConnected: true,
    _textNodes: [],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 400 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}

test('copyReceiptPng supports Safari Promise-in-ClipboardItem, Chromium TypeError fallback, unsupported environments, and change/disconnect guards', async () => {
  try {
    // 0. renderReceiptPngBlob returns the rendered PNG blob directly without triggering a download.
    let anchorCreated = false
    setupCanvasStub((cb) => cb({ size: 128, type: 'image/png' }))
    const origCreateElementImpl = env.createElementImpl
    env.createElementImpl = (tag) => {
      if (tag === 'a') anchorCreated = true
      return origCreateElementImpl(tag)
    }
    const directBlob = await renderReceiptPngBlob(makePaperStub('en', 'usd'), DICT.en)
    assert.deepEqual(directBlob, { size: 128, type: 'image/png' })
    assert.equal(anchorCreated, false)

    // 1. Null paper guard.
    await assert.rejects(copyReceiptPng(null, DICT.en), new RegExp(DICT.en.exportNotReady))

    // 2. Missing clipboard API or ClipboardItem throws localized clipboardUnsupported.
    windowObj.navigator = undefined
    windowObj.ClipboardItem = undefined
    await assert.rejects(copyReceiptPng(makePaperStub(), DICT.zh), new RegExp(DICT.zh.clipboardUnsupported))

    windowObj.navigator = { clipboard: {} }
    windowObj.ClipboardItem = function MockItem() {}
    await assert.rejects(copyReceiptPng(makePaperStub(), DICT.ja), new RegExp(DICT.ja.clipboardUnsupported))

    windowObj.navigator = { clipboard: { async write() {} } }
    windowObj.ClipboardItem = undefined
    await assert.rejects(copyReceiptPng(makePaperStub(), DICT.en), new RegExp(DICT.en.clipboardUnsupported))

    // 3. Safari / modern path: ClipboardItem({ 'image/png': Promise<Blob> }) + clipboard.write invoked synchronously during click gesture.
    let resolveFonts
    fonts.ready = new Promise((resolve) => { resolveFonts = resolve })
    const createdItems = []
    const writeCalls = []
    let resolveWrite
    let pendingBlobCb = null
    setupCanvasStub((cb) => { pendingBlobCb = cb })
    windowObj.ClipboardItem = class SafariClipboardItem {
      constructor(items) {
        this.items = items
        createdItems.push(items)
      }
    }
    windowObj.navigator = {
      clipboard: {
        write(items) {
          writeCalls.push(items)
          return new Promise((resolve) => { resolveWrite = resolve })
        },
      },
    }

    const safariPaper = makePaperStub('en', 'usd')
    const safariCopy = copyReceiptPng(safariPaper, DICT.en)
    // Invoked synchronously before any microtask tick!
    assert.equal(createdItems.length, 1)
    assert.equal(typeof createdItems[0]['image/png']?.then, 'function', 'Safari path must pass Promise<Blob> to ClipboardItem')
    assert.equal(writeCalls.length, 1, 'clipboard.write must be invoked synchronously inside user gesture')

    resolveFonts()
    await flushMicrotasks()
    const renderedBlob = { size: 256, type: 'image/png' }
    pendingBlobCb(renderedBlob)
    assert.equal(await createdItems[0]['image/png'], renderedBlob)
    resolveWrite()
    await safariCopy

    // 4. Legacy Chromium fallback A: new ClipboardItem({ 'image/png': Promise }) throws TypeError -> falls back to resolved Blob.
    fonts.ready = Promise.resolve()
    const chromiumItemsA = []
    const chromiumWritesA = []
    setupCanvasStub((cb) => cb({ size: 300, type: 'image/png' }))
    windowObj.ClipboardItem = class LegacyClipboardItem {
      constructor(items) {
        if (items['image/png'] && typeof items['image/png'].then === 'function') {
          throw new TypeError('Failed to construct ClipboardItem: value is not a Blob')
        }
        this.items = items
        chromiumItemsA.push(items)
      }
    }
    windowObj.navigator = {
      clipboard: {
        async write(items) {
          chromiumWritesA.push(items)
        },
      },
    }
    await copyReceiptPng(makePaperStub('en', 'usd'), DICT.en)
    assert.equal(chromiumItemsA.length, 1)
    assert.equal(chromiumItemsA[0]['image/png'].size, 300)
    assert.equal(chromiumWritesA.length, 1)

    // 5. Legacy Chromium fallback B: ClipboardItem accepts Promise, but clipboard.write rejects with TypeError -> retries with resolved Blob.
    const chromiumItemsB = []
    const chromiumWritesB = []
    setupCanvasStub((cb) => cb({ size: 400, type: 'image/png' }))
    windowObj.ClipboardItem = class RetryClipboardItem {
      constructor(items) {
        this.items = items
        chromiumItemsB.push(items)
      }
    }
    windowObj.navigator = {
      clipboard: {
        async write(items) {
          chromiumWritesB.push(items)
          if (typeof items[0].items['image/png']?.then === 'function') {
            throw new TypeError('ClipboardItem promise unsupported')
          }
        },
      },
    }
    await copyReceiptPng(makePaperStub('en', 'usd'), DICT.en)
    assert.equal(chromiumItemsB.length, 2)
    assert.equal(typeof chromiumItemsB[0]['image/png'].then, 'function')
    assert.equal(chromiumItemsB[1]['image/png'].size, 400)
    assert.equal(chromiumWritesB.length, 2)

    // 6. Non-TypeError clipboard failure (e.g. NotAllowedError) rejects without retrying.
    let nonTypeWriteCount = 0
    setupCanvasStub((cb) => cb({ size: 512, type: 'image/png' }))
    windowObj.ClipboardItem = class BasicClipboardItem {
      constructor(items) { this.items = items }
    }
    windowObj.navigator = {
      clipboard: {
        async write() {
          nonTypeWriteCount += 1
          throw new Error('NotAllowedError')
        },
      },
    }
    await assert.rejects(copyReceiptPng(makePaperStub('en', 'usd'), DICT.en), /NotAllowedError/)
    assert.equal(nonTypeWriteCount, 1)

    // 7. Disconnect or currency change during copy rejects and does NOT write a stale image.
    for (const change of ['currency', 'disconnect']) {
      // Legacy path (throws TypeError on Promise): clipboard.write must never be called.
      let legacyWriteCount = 0
      let ready
      fonts.ready = new Promise((resolve) => { ready = resolve })
      windowObj.ClipboardItem = class GuardLegacyClipboardItem {
        constructor(items) {
          if (typeof items['image/png']?.then === 'function') throw new TypeError('Blob required')
          this.items = items
        }
      }
      windowObj.navigator = {
        clipboard: {
          async write() { legacyWriteCount += 1 },
        },
      }
      const guardedPaper = makePaperStub('en', 'usd')
      const legacyCopy = copyReceiptPng(guardedPaper, DICT.en)
      if (change === 'currency') guardedPaper.dataset.currency = 'jpy'
      else guardedPaper.isConnected = false
      ready()
      await assert.rejects(legacyCopy, change === 'disconnect' ? /Receipt was closed/ : /language or currency changed/)
      assert.equal(legacyWriteCount, 0)

      // Safari path (ClipboardItem awaits Promise): clipboard.write rejects with the guard error and receives no Blob.
      let readySafari
      fonts.ready = new Promise((resolve) => { readySafari = resolve })
      windowObj.ClipboardItem = class GuardSafariClipboardItem {
        constructor(items) { this.items = items }
      }
      windowObj.navigator = {
        clipboard: {
          async write(items) { await items[0].items['image/png'] },
        },
      }
      const safariGuardPaper = makePaperStub('en', 'usd')
      const safariGuardCopy = copyReceiptPng(safariGuardPaper, DICT.en)
      if (change === 'currency') safariGuardPaper.dataset.currency = 'cny'
      else safariGuardPaper.isConnected = false
      readySafari()
      await assert.rejects(safariGuardCopy, change === 'disconnect' ? /Receipt was closed/ : /language or currency changed/)
    }
  } finally {
    fonts.ready = Promise.resolve()
    env.createElementImpl = null
    windowObj.navigator = undefined
    windowObj.ClipboardItem = undefined
  }
})

test('Panel Copy image button writes PNG to clipboard, locks controls, handles error retry and mutual exclusion, and cleans up 3200ms timer', async () => {
  timers.clear()
  reducedMotion = false
  try {
    env.fetchImpl = async () => ({
      ok: true,
      status: 200,
      json: async () => sampleBill(),
    })

    const ctx = createMockCtx('en')
    const view = mount(Panel, { ctx })
    await flushMicrotasks()
    runTimerMatching((ms) => ms > 0 && ms <= 850, 'copy test MIN_PROCESSING_MS')
    await flushMicrotasks()
    runTimerMatching((ms) => ms === 1900, 'copy test feed')
    await flushMicrotasks()

    assert.equal(
      findAll(view.tree, (n) => n.type === 'button' && (textOf(n) === 'Print / PDF' || textOf(n) === '打印 / PDF')).length,
      0,
    )

    let pendingBlobCb = null
    setupCanvasStub((cb) => { pendingBlobCb = cb })
    const clipboardWrites = []
    windowObj.ClipboardItem = class PanelClipboardItem {
      constructor(items) { this.items = items }
    }
    windowObj.navigator = {
      clipboard: {
        async write(items) {
          clipboardWrites.push(items)
          await items[0].items['image/png']
        },
      },
    }

    const articleNode = findAll(view.tree, (n) => n.type === 'article')[0]
    articleNode.props.ref.current = makePaperStub('en', 'usd')

    const copyBtn = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copyImage)[0]
    assert.ok(copyBtn)
    assert.equal(copyBtn.props.disabled, false)
    assert.equal(copyBtn.children[0].type, 'svg')
    assert.equal(copyBtn.children[0].children[0].type, 'rect')

    const copyPromise = copyBtn.props.onClick()
    await flushMicrotasks()
    assert.equal(clipboardWrites.length, 1)

    // While copying: label shows Copying..., sr-only status updated, and all controls are locked.
    const copyingBtn = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copyingImage)[0]
    assert.ok(copyingBtn)
    assert.equal(copyingBtn.props.disabled, true)
    assert.equal(textOf(findAll(view.tree, (n) => n.props?.className === 'tr-sr-only')[0]), DICT.en.copyingImage)
    for (const btn of findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))) {
      assert.equal(btn.props.disabled, true, 'period buttons must lock while copying')
    }
    assert.equal(findAll(view.tree, (n) => n.type === 'select')[0].props.disabled, true)
    assert.equal(findAll(view.tree, (n) => n.props?.className === 'tr-datepicker')[0].props.disabled, true)
    assert.equal(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.savePng)[0].props.disabled, true)
    assert.equal(findAll(view.tree, (n) => String(n.props?.className || '').includes('tr-btn-primary'))[0].props.disabled, true)

    // Finish copy -> shows Copied + CheckCircle, unlocks controls, schedules 3200ms timer.
    pendingBlobCb({ size: 96, type: 'image/png' })
    await copyPromise
    const copiedBtn = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copiedImage)[0]
    assert.ok(copiedBtn)
    assert.equal(copiedBtn.children[0].type, 'svg')
    assert.equal(copiedBtn.children[0].children[0].type, 'circle')
    assert.equal(copiedBtn.children[0].children[0].props.fill, '#30a46c')
    assert.equal(textOf(findAll(view.tree, (n) => n.props?.className === 'tr-sr-only')[0]), DICT.en.copiedImage)
    assert.equal(findAll(view.tree, (n) => n.type === 'select')[0].props.disabled, false)
    assert.equal([...timers.values()].some((t) => t.ms === 3200), true)

    // 3200ms timer resets Copy button back to idle.
    runTimerMatching((ms) => ms === 3200, 'copyState reset')
    assert.ok(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copyImage)[0])

    // Missing clipboard shows localized clipboardUnsupported in .tr-save-error with working Retry button.
    windowObj.navigator = undefined
    const copyIdleBtn = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copyImage)[0]
    await copyIdleBtn.props.onClick()
    const errorBanner = findAll(view.tree, (n) => n.props?.className === 'tr-save-error')[0]
    assert.ok(errorBanner)
    assert.ok(textOf(errorBanner).includes(DICT.en.copyFailed))
    assert.ok(textOf(errorBanner).includes(DICT.en.clipboardUnsupported))

    // Restore clipboard and click Retry inside .tr-save-error -> succeeds and clears error banner.
    setupCanvasStub((cb) => cb({ size: 120, type: 'image/png' }))
    windowObj.navigator = {
      clipboard: {
        async write(items) { await items[0].items['image/png'] },
      },
    }
    const retryBtn = findAll(errorBanner, (n) => n.type === 'button' && textOf(n) === DICT.en.retry)[0]
    assert.ok(retryBtn)
    await retryBtn.props.onClick()
    assert.equal(findAll(view.tree, (n) => n.props?.className === 'tr-save-error').length, 0)
    assert.ok(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copiedImage)[0])
    assert.equal([...timers.values()].some((t) => t.ms === 3200), true)

    // Starting Save PNG clears prior copyState / copyTimerRef cleanly.
    setupCanvasStub((cb) => { pendingBlobCb = cb })
    const saveBtn = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.savePng)[0]
    const savePromise = saveBtn.props.onClick()
    await flushMicrotasks()
    assert.ok(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copyImage)[0], 'starting save clears copied badge')
    pendingBlobCb({ size: 120, type: 'image/png' })
    await savePromise

    // Trigger copy again so 3200ms copyTimerRef is active, then unmount and confirm timer cleanup.
    setupCanvasStub((cb) => cb({ size: 120, type: 'image/png' }))
    await findAll(view.tree, (n) => n.type === 'button' && textOf(n) === DICT.en.copyImage)[0].props.onClick()
    assert.equal([...timers.values()].some((t) => t.ms === 3200), true)
    view.unmount()
    assert.equal([...timers.values()].some((t) => t.ms === 3200), false, 'unmount must clear copyTimerRef')
  } finally {
    timers.clear()
    env.createElementImpl = null
    windowObj.navigator = undefined
    windowObj.ClipboardItem = undefined
  }
})

test('days30, days90, and all periods compute ranges, keys, bill numbers, date formatting, static toolbar UI, and replay print animations', async () => {
  timers.clear()
  reducedMotion = false
  try {
    // 1. Unit checks for period helpers and billNumber codes.
    assert.deepEqual([...PERIODS], ['day', 'week', 'month', 'days30', 'days90', 'all'])
    for (const p of ['day', 'week', 'month']) assert.equal(isSteppablePeriod(p), true)
    for (const p of ['days30', 'days90', 'all']) assert.equal(isSteppablePeriod(p), false)

    const fixedNow = new Date(2026, 10, 17, 14, 30, 0)
    const r30 = periodRange('days30', fixedNow, fixedNow)
    assert.equal(dateKey(r30.start), '2026-10-19')
    assert.equal(dateKey(r30.end), '2026-11-18')
    assert.equal(periodKey('days30', r30.start, r30.end), '2026-11-17')

    const r90 = periodRange('days90', fixedNow, fixedNow)
    assert.equal(dateKey(r90.start), '2026-08-20')
    assert.equal(dateKey(r90.end), '2026-11-18')
    assert.equal(periodKey('days90', r90.start, r90.end), '2026-11-17')

    const rAll = periodRange('all', fixedNow, fixedNow)
    assert.equal(rAll.start.getTime(), 1)
    assert.equal(dateKey(rAll.end), '2026-11-18')
    assert.equal(periodKey('all', rAll.start, rAll.end), '2026-11-17')

    assert.ok(billNumber('day', '2026-11-17', 100, 1).startsWith('TR-D-20261117-'))
    assert.ok(billNumber('week', '2026-11-09', 100, 1).startsWith('TR-W-20261109-'))
    assert.ok(billNumber('month', '2026-11', 100, 1).startsWith('TR-M-202611-'))
    assert.ok(billNumber('days30', '2026-11-17', 100, 1).startsWith('TR-30D-20261117-'))
    assert.ok(billNumber('days90', '2026-11-17', 100, 1).startsWith('TR-90D-20261117-'))
    assert.ok(billNumber('all', '2026-11-17', 100, 1).startsWith('TR-ALL-20261117-'))

    // Cross-year vs same-year English range formatting, and all-time formatting.
    const crossStart = new Date(2025, 11, 20)
    const crossEndExcl = new Date(2026, 0, 19)
    assert.equal(periodLabel('days30', crossStart, crossEndExcl, 'en'), 'Dec 20, 2025 – Jan 18, 2026')
    assert.equal(periodLabel('days30', crossStart, crossEndExcl, 'zh'), '2025年12月20日 – 2026年1月18日')
    assert.equal(periodLabel('days30', crossStart, crossEndExcl, 'ja'), '2025年12月20日〜2026年1月18日')

    const sameYearStart = new Date(2026, 10, 9)
    const sameYearEndExcl = new Date(2026, 10, 16)
    assert.equal(periodLabel('week', sameYearStart, sameYearEndExcl, 'en'), 'Nov 9 – Nov 15, 2026')

    assert.equal(periodLabel('all', new Date(1), crossEndExcl, 'en'), DICT.en.allTime)
    assert.equal(periodLabel('all', new Date(1), crossEndExcl, 'zh'), DICT.zh.allTime)
    assert.equal(periodLabel('all', new Date(1), crossEndExcl, 'ja'), DICT.ja.allTime)
    assert.equal(relativeLabel('all', new Date(1), DICT.en), '')
    assert.equal(relativeLabel('all', crossStart, DICT.en), DICT.en.allTime)

    const singleDayEndExcl = new Date(2026, 10, 18)
    assert.equal(periodLabel('all', new Date(2026, 10, 17), singleDayEndExcl, 'en'), 'Nov 17, 2026')

    // 2. Receipt component formatting with period === 'all' (firstAt null vs cross-year timestamp).
    const allNullTree = expand(React.createElement(Receipt, {
      copy: DICT.en,
      locale: 'en',
      data: sampleBill({ period: 'all', from: 1, to: singleDayEndExcl.getTime(), date: '2026-11-17', firstAt: null }),
      period: 'all',
      currency: 'usd',
    }))
    const nullPaperDate = textOf(findAll(allNullTree, (n) => n.props?.className === 'tr-paper-date')[0])
    assert.equal(nullPaperDate, DICT.en.allTime)
    assert.equal(nullPaperDate.includes('1970'), false)
    const metaValues = findAll(allNullTree, (n) => n.type === 'dd').map(textOf)
    assert.ok(metaValues.some((v) => v.startsWith('TR-ALL-20261117-')))
    assert.ok(metaValues.includes(DICT.en.all))

    const allWithFirstAtTree = expand(React.createElement(Receipt, {
      copy: DICT.en,
      locale: 'en',
      data: sampleBill({
        period: 'all',
        from: 1,
        to: singleDayEndExcl.getTime(),
        date: '2026-11-17',
        firstAt: new Date(2025, 11, 20, 14, 0).getTime(),
      }),
      period: 'all',
      currency: 'usd',
    }))
    assert.equal(
      textOf(findAll(allWithFirstAtTree, (n) => n.props?.className === 'tr-paper-date')[0]),
      'Dec 20, 2025 – Nov 17, 2026',
    )

    // 3. Panel integration: 6 period buttons across locales, query params, static datebox, print replay, and Today button.
    const fetchedUrls = []
    let nextBill = sampleBill()
    env.fetchImpl = async (url) => {
      fetchedUrls.push(url)
      return { ok: true, status: 200, json: async () => nextBill }
    }

    const ctx = createMockCtx('en')
    const view = mount(Panel, { ctx })
    await flushMicrotasks()
    runTimerMatching((ms) => ms > 0 && ms <= 850, 'initial MIN_PROCESSING_MS')
    await flushMicrotasks()
    runTimerMatching((ms) => ms === 1900, 'initial feed')
    await flushMicrotasks()
    const key0 = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props.key

    const periodBtns = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))
    assert.deepEqual(
      periodBtns.map(textOf),
      [DICT.en.day, DICT.en.week, DICT.en.month, DICT.en.days30, DICT.en.days90, DICT.en.all],
    )

    // Switch to days30 -> plays print animation, hides steppable controls, shows static datebox.
    const today = startOfDay(new Date())
    const expectedTodayKey = dateKey(today)
    const d30Start = periodRange('days30', today, today)
    nextBill = sampleBill({ period: 'days30', from: d30Start.start.getTime(), to: d30Start.end.getTime(), date: expectedTodayKey })
    periodBtns.find((b) => textOf(b) === DICT.en.days30).props.onClick()
    await flushMicrotasks()

    const url30 = new URL(fetchedUrls[1], 'http://localhost')
    assert.equal(url30.searchParams.get('period'), 'days30')
    assert.equal(Number(url30.searchParams.get('from')), d30Start.start.getTime())
    assert.equal(Number(url30.searchParams.get('to')), d30Start.end.getTime())
    assert.equal(url30.searchParams.get('date'), expectedTodayKey)

    assert.equal(findAll(view.tree, (n) => n.props?.className === 'tr-navbtn').length, 0)
    assert.equal(findAll(view.tree, (n) => n.props?.className === 'tr-datepicker').length, 0)
    assert.equal(findAll(view.tree, (n) => String(n.props?.className || '').includes('tr-todaybtn')).length, 0)
    const staticBox30 = findAll(view.tree, (n) => n.props?.className === 'tr-datebox is-static')[0]
    assert.ok(staticBox30)
    assert.equal(textOf(findAll(staticBox30, (n) => n.props?.className === 'tr-daterel')[0]), DICT.en.days30)

    runTimerMatching((ms) => ms > 0 && ms <= 850, 'days30 MIN_PROCESSING_MS')
    await flushMicrotasks()
    const wrap30 = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0]
    assert.equal(wrap30.props['data-stage'], 'printing')
    assert.notEqual(wrap30.props.key, key0)
    runTimerMatching((ms) => ms === 1900, 'days30 feed')
    await flushMicrotasks()
    assert.equal(findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'], 'complete')

    // Switch to days90 -> replays print animation again and verifies query params.
    const d90Start = periodRange('days90', today, today)
    nextBill = sampleBill({ period: 'days90', from: d90Start.start.getTime(), to: d90Start.end.getTime(), date: expectedTodayKey })
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))
      .find((b) => textOf(b) === DICT.en.days90).props.onClick()
    await flushMicrotasks()
    const url90 = new URL(fetchedUrls[2], 'http://localhost')
    assert.equal(url90.searchParams.get('period'), 'days90')
    assert.equal(Number(url90.searchParams.get('from')), d90Start.start.getTime())
    assert.equal(url90.searchParams.get('date'), expectedTodayKey)
    runTimerMatching((ms) => ms > 0 && ms <= 850, 'days90 MIN_PROCESSING_MS')
    await flushMicrotasks()
    const wrap90 = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0]
    assert.equal(wrap90.props['data-stage'], 'printing')
    assert.notEqual(wrap90.props.key, wrap30.props.key)
    runTimerMatching((ms) => ms === 1900, 'days90 feed')
    await flushMicrotasks()

    // Switch to all with firstAt: null -> sends from=1 and non-1970 date, renders All time without duplicate sublabel.
    const allRange = periodRange('all', today, today)
    nextBill = sampleBill({ period: 'all', from: 1, to: allRange.end.getTime(), date: expectedTodayKey, firstAt: null })
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))
      .find((b) => textOf(b) === DICT.en.all).props.onClick()
    await flushMicrotasks()
    const urlAll = new URL(fetchedUrls[3], 'http://localhost')
    assert.equal(urlAll.searchParams.get('period'), 'all')
    assert.equal(urlAll.searchParams.get('from'), '1')
    assert.equal(urlAll.searchParams.get('date'), expectedTodayKey)
    assert.equal(urlAll.searchParams.get('date').startsWith('1970'), false)
    runTimerMatching((ms) => ms > 0 && ms <= 850, 'all MIN_PROCESSING_MS')
    await flushMicrotasks()
    runTimerMatching((ms) => ms === 1900, 'all feed')
    await flushMicrotasks()
    const staticBoxAllNull = findAll(view.tree, (n) => n.props?.className === 'tr-datebox is-static')[0]
    assert.equal(textOf(findAll(staticBoxAllNull, (n) => n.props?.className === 'tr-datemain')[0]), DICT.en.allTime)
    assert.equal(findAll(staticBoxAllNull, (n) => n.props?.className === 'tr-daterel').length, 0)

    // Verify Zh locale displays localized 6 period buttons and 全部时间 for null firstAt.
    ctx.setLocale('zh-CN')
    assert.deepEqual(
      findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn')).map(textOf),
      [DICT.zh.day, DICT.zh.week, DICT.zh.month, DICT.zh.days30, DICT.zh.days90, DICT.zh.all],
    )
    assert.equal(
      textOf(findAll(view.tree, (n) => n.props?.className === 'tr-paper-date')[0]),
      DICT.zh.allTime,
    )

    // Switch back to days30 then to all with non-null firstAt -> renders range + All time relative sublabel.
    ctx.setLocale('en')
    nextBill = sampleBill({ period: 'days30', from: d30Start.start.getTime(), to: d30Start.end.getTime(), date: expectedTodayKey })
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))
      .find((b) => textOf(b) === DICT.en.days30).props.onClick()
    await flushMicrotasks()
    runTimerMatching((ms) => ms > 0 && ms <= 850, 'days30 before all-with-firstAt MIN_PROCESSING_MS')
    await flushMicrotasks()
    runTimerMatching((ms) => ms === 1900, 'days30 before all-with-firstAt feed')
    await flushMicrotasks()

    const earlierFirstAt = new Date(today.getFullYear() - 1, 11, 20, 9, 0).getTime()
    nextBill = sampleBill({ period: 'all', from: 1, to: allRange.end.getTime(), date: expectedTodayKey, firstAt: earlierFirstAt })
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))
      .find((b) => textOf(b) === DICT.en.all).props.onClick()
    await flushMicrotasks()
    runTimerMatching((ms) => ms > 0 && ms <= 850, 'all-with-firstAt MIN_PROCESSING_MS')
    await flushMicrotasks()
    runTimerMatching((ms) => ms === 1900, 'all-with-firstAt feed')
    await flushMicrotasks()
    const staticBoxAllData = findAll(view.tree, (n) => n.props?.className === 'tr-datebox is-static')[0]
    assert.equal(
      textOf(findAll(staticBoxAllData, (n) => n.props?.className === 'tr-datemain')[0]),
      periodLabel('all', startOfDay(new Date(earlierFirstAt)), allRange.end, 'en'),
    )
    assert.equal(
      textOf(findAll(staticBoxAllData, (n) => n.props?.className === 'tr-daterel')[0]),
      DICT.en.allTime,
    )

    // Switch back to days30 then click machine Today button -> returns to day, restores steppable controls, and replays animation!
    nextBill = sampleBill({ period: 'days30', from: d30Start.start.getTime(), to: d30Start.end.getTime(), date: expectedTodayKey })
    findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-periodbtn'))
      .find((b) => textOf(b) === DICT.en.days30).props.onClick()
    await flushMicrotasks()
    runTimerMatching((ms) => ms > 0 && ms <= 850, 'days30 before Today MIN_PROCESSING_MS')
    await flushMicrotasks()
    runTimerMatching((ms) => ms === 1900, 'days30 before Today feed')
    await flushMicrotasks()
    const keyBeforeToday = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props.key

    nextBill = sampleBill({ period: 'day' })
    const machineTodayBtn = findAll(view.tree, (n) => n.props?.className === 'tr-machine-btn')[0]
    machineTodayBtn.props.onClick()
    await flushMicrotasks()
    const urlToday = new URL(fetchedUrls[fetchedUrls.length - 1], 'http://localhost')
    assert.equal(urlToday.searchParams.get('period'), 'day')
    assert.equal(urlToday.searchParams.get('date'), expectedTodayKey)
    assert.equal(findAll(view.tree, (n) => n.props?.className === 'tr-navbtn').length, 2, 'steppable nav buttons should return on day')
    assert.equal(findAll(view.tree, (n) => n.props?.className === 'tr-datepicker').length, 1, 'datepicker should return on day')

    runTimerMatching((ms) => ms > 0 && ms <= 850, 'Today return MIN_PROCESSING_MS')
    await flushMicrotasks()
    const wrapToday = findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0]
    assert.equal(wrapToday.props['data-stage'], 'printing')
    assert.notEqual(wrapToday.props.key, keyBeforeToday)
    runTimerMatching((ms) => ms === 1900, 'Today return feed')
    await flushMicrotasks()
    assert.equal(findAll(view.tree, (n) => String(n.props?.className || '').startsWith('tr-paper-wrap'))[0].props['data-stage'], 'complete')

    view.unmount()
    assert.equal(timers.size, 0)
  } finally {
    timers.clear()
    reducedMotion = false
    env.createElementImpl = null
  }
})

