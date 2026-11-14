# Estimated token costs / Token 费用估算

The receipt uses public **models.dev reference prices**, not your provider's invoice. Session text, model usage and provider credentials are never uploaded. The Host fetches only the public catalogue at https://models.dev/api.json.

## Formula

All calculations use USD per one million tokens:

```text
USD = (inputTokens × inputRate
     + cacheReadTokens × cacheReadRate
     + cacheWriteTokens × cacheWriteRate
     + outputTokens × outputRate) / 1,000,000
```

DSH's `inputTokens` is used as the uncached input bucket, consistent with dsh-context. Cache tokens are separate; do not subtract them again. `reasoningTokens` is retained as usage information but not charged a second time on top of output.

A missing cache-read or cache-write rate falls back to that model's input rate. An explicit zero remains zero. Entries without a finite, nonnegative input and output rate cannot be priced.

Usage is priced per provider, full model ID and event time before any display rows combine. Day, week and month select different time windows; they use the same pricing formula.

## Catalogue and matching

The catalogue is cached for one hour. Requests are deduplicated, have an eight-second timeout, and use a thirty-second backoff after an initial failure. A previously downloaded catalogue remains usable after a refresh failure and is marked stale. A failure to fetch prices does not erase usage or turn the estimate into a zero-cost bill.

Provider-specific prices take precedence. Matching follows dsh-context's provider aliases, provider-local normalized forms, organization IDs, canonical maker hints, model families and unambiguous global matches. Different candidate prices produce an unpriced result, not an arbitrary selection. Subscription `coding-plan`, `code-plan` and `token-plan` branches are excluded from the per-token index; a maker reference may still be available.

### WorkBuddy override

The requested exception is explicit:

```text
workbuddy / deepseek-v4.1-flash
    → deepseek / deepseek-v4-flash
```

This route uses the official Flash reference rates even when normal matching would be ambiguous. Both a direct WorkBuddy provider and a gateway model ID such as `magpie / workbuddy/deepseek-v4.1-flash` identify the same explicit override. It is marked `user-override` in the API response; source and override annotations are omitted from the receipt. If the official entry is unavailable, the route remains unpriced; no bundled or invented rate is substituted.

The override uses the same peak-time policy as the official DeepSeek route. Ordinary third-party channels retain their own provider price and are not silently repriced to DeepSeek.

## Peak periods

As in the referenced dsh-context implementation, official DeepSeek providers (`deepseek`, `deepseek-official`, `deepseek-account`) and the WorkBuddy override use a factor of **2** during these Beijing / UTC+8 windows:

- Monday–Friday, 09:00 inclusive to 12:00 exclusive.
- Monday–Friday, 14:00 inclusive to 18:00 exclusive.

Other hours and weekends use factor 1. Each message is classified at its recorded event time, so weekly and monthly bills can contain both peak and off-peak usage. This policy checks weekdays, not a public-holiday or adjusted-working-day calendar.

## Currency and display

The default is **Follow language**: Chinese uses CNY, English uses USD, and Japanese uses JPY. Automatic mode updates when the interface language changes. Selecting USD, CNY or JPY manually keeps that selection for the current panel, even when the language changes; selecting Follow language restores automatic behavior. Reopening the panel starts in automatic mode.

All prices and API amounts remain unrounded USD. Display conversion uses these fixed reference rates:

```text
USD = USD
CNY = USD / 0.15       (1 USD ≈ 6.67 CNY, retained from dsh-context)
JPY = USD × 160       (2026-11-13 reference quote)
```

The JPY rate was verified against the [Frankfurter historical USD/JPY quote](https://api.frankfurter.dev/v1/2026-11-13?base=USD&symbols=JPY). It is a dated reference, not a live exchange rate. The JPY receipt note includes the rate and date. No extra FX network request is made while printing.

USD and CNY normally show two decimal places; JPY normally shows whole yen. Small positive estimates retain up to six decimal places (below one cent for USD/CNY and below one yen for JPY). A positive amount below 0.000001 of the display currency is shown as `<$0.000001` or `<¥0.000001`, so a nonzero charge is never rounded into a free bill. The receipt also prints the currency code, distinguishing CNY and JPY even though both use the ¥ symbol.

- **Estimated total**: every request has a matched price.
- **Priced subtotal**: only matched requests are included; the receipt reports how many remain unpriced.
- **— / Prices unavailable**: no usable estimate; this is not zero.
- **$0.00**: an empty period or an explicitly free matched price.

Model lines may combine the same short model name for readability, but their monetary amounts have already been calculated independently on the Host. A partially priced combined line is marked with `≈`. PNG and print output use the same receipt data and display currency.

## Limits

This is a reference estimate. Private contracts, subscriptions, credits, reseller discounts, taxes and payment fees are not inferred. The four-rate model does not implement all catalogue conditions: long-context tiers, cache TTL variants, service-tier/region multipliers and tool-side charges may differ. The inherited DeepSeek weekday policy also omits Chinese public-holiday exclusions, and nonofficial providers such as OpenCode Go may have their own multipliers that are not implemented here.

Prices are fetched from the currently available catalogue. The plugin does not keep a historical price ledger, so older usage can be re-estimated at newer prices. Keep a saved receipt if you need a fixed record of an estimate.

## 中文摘要

- 金额由未缓存输入、缓存读、缓存写和输出四类 Token 分别计算，单位是美元／百万 Token。
- 按供应商、完整模型 ID 和消息时间计费后再汇总，日／周／月沿用同一规则。
- `workbuddy / deepseek-v4.1-flash` 按你的要求使用 `deepseek / deepseek-v4-flash` 官方参考价，并沿用官方峰谷倍率；回退记录保留在 API 中，小票不显示来源及回退说明。
- 默认币种跟随语言：中文 CNY、英文 USD、日文 JPY；手动选定币种后保留当前选择，选「跟随语言」恢复自动，重新打开面板默认自动。
- USD 为计算基准；CNY 固定按 `USD / 0.15` 换算，JPY 按 2026-11-13 的参考汇率 `USD × 160` 换算。两者都不是实时汇率。缺价不记成免费，部分计价显示为小计。
- 用量和会话始终保留在本机，仅联网获取公开价格目录。金额是参考估算，不是实付账单；阶梯价、订阅优惠、税费等不在当前模型内。

## References and attribution

- [dsh-context model pricing design](https://github.com/bowenliang123/dsh-context/blob/d81325ec6bab9dae9bf83e7a866ac74119504e18/docs/model-pricing-mapping.md)
- [dsh-context pricing source](https://github.com/bowenliang123/dsh-context/blob/d81325ec6bab9dae9bf83e7a866ac74119504e18/src/shared/pricing.ts)
- [models.dev catalogue](https://models.dev/api.json)
- [Receipt Printer visual reference](https://www.dqnamo.com/experiments/receipt-printer)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)
