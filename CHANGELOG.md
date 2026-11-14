# Changelog

All notable changes to this project are documented here.

## Unreleased

- Add Japanese plugin metadata, sidebar and receipt translations, date formatting, and Japanese font fallbacks.
- Estimate model costs from the public models.dev catalogue, with a one-hour cache.
- Preserve provider/model identity and price input, cache reads, cache writes, and output separately.
- Use the DeepSeek Flash official reference rate and peak policy for WorkBuddy's deepseek-v4.1-flash route.
- Add model line amounts, cost breakdown, estimated total, and USD/CNY/JPY selection to the receipt.
- Default currency follows the interface language, with an explicit automatic mode and manual overrides.
- Convert JPY using a dated reference rate (2026-11-13: 1 USD = 160 JPY); preserve fractional-yen precision for small estimates.
- Mark missing prices, partial subtotals, stale prices, and the WorkBuddy reference-rate override.
- Keep the DSH whale logo and include monetary amounts and pricing notes in PNG/print output.

## 1.0.0 — 2026-11-14

- Initial release.
- Daily, weekly, and monthly token usage bills.
- Receipt-printer animation with stepped paper feed, torn edge, and barcode.
- Save the receipt as a 3× PNG.
- Print / PDF action with a print-only stylesheet.
- Light/dark themes, Chinese/English UI, and reduced-motion support.
