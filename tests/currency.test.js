import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Exercise pure helpers, dictionaries, and early export cancellation from the
// shipped client bundle. No React components, DOM, or canvas are rendered.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const exportLine = "return { inject: ['slots', 'locale'], apply }"
assert.ok(source.includes(exportLine), 'client factory export must be discoverable')
let definition
const fonts = { ready: Promise.resolve() }
vm.runInNewContext(source.replace(exportLine,
  'return { defaultCurrencyForLocale, resolveCurrencyPreference, fmtMoney, DISPLAY_RATES, JPY_RATE_DATE, DICT, exportReceiptPng }'), {
  window: { __ModuleLoader__: { load(value) { definition = value } } },
  document: { fonts },
})
const { defaultCurrencyForLocale, resolveCurrencyPreference, fmtMoney, DISPLAY_RATES, JPY_RATE_DATE, DICT, exportReceiptPng } = definition.factory((name) => {
  assert.equal(name, 'react')
  return {} // The pure functions do not use React.
})

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

test('all three language dictionaries include matching currency keys and placeholders', () => {
  const keys = Object.keys(DICT.en).sort()
  for (const language of ['zh', 'ja']) {
    assert.deepEqual(Object.keys(DICT[language]).sort(), keys)
    for (const key of keys) {
      assert.ok(DICT[language][key].trim())
      assert.deepEqual(DICT[language][key].match(/\{[^}]+\}/g) || [], DICT.en[key].match(/\{[^}]+\}/g) || [])
    }
  }
  assert.ok(DICT.ja.autoCurrency)
  assert.ok(DICT.ja.exchangeRateJpy.includes('{rate}'))
  assert.ok(DICT.ja.exchangeRateJpy.includes('{date}'))
})
