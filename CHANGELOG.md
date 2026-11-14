# Changelog

All notable changes to this project are documented in this file.

## 1.0.0

Released on 2026-11-14.

- Print daily, weekly, and monthly token usage receipts with quick date navigation.
- Render a stepped receipt-printer feed animation with a torn paper edge, barcode, and `prefers-reduced-motion` support.
- Estimate model and token-category costs from the public [models.dev](https://models.dev) catalog across input, output, cache read, and cache write tokens, including built-in gateway route mappings and peak-hour adjustments.
- Match the default currency to the interface language, with manual switching between `USD`, `CNY`, and `JPY` and status notes for unpriced, partial, or cached rates.
- Export receipts as 3x high-resolution PNG images or print and save to PDF through the system print dialog.
- Support English, Simplified Chinese, and Japanese interfaces across light and dark themes.
