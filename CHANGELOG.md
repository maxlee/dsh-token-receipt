# Changelog

All notable changes to this project are documented in this file.

## 1.1.0

Released on 2026-11-17.

- Replace the `Print / PDF` action with `Copy image` to copy a 3x PNG receipt directly to the clipboard for instant pasting and sharing alongside `Save PNG`.
- Add `30 days`, `90 days`, and `All` (`days30`, `days90`, `all`) receipt periods with `TR-30D-`, `TR-90D-`, and `TR-ALL-` bill numbers and real matched-session date spans.
- Replay the stepped receipt-printer paper-feed animation automatically whenever switching periods or navigating dates.
- Harden pricing catalog refresh cancellation/timeouts, session LRU caching, and Node 22/24 test runner compatibility.

## 1.0.0

Released on 2026-11-14.

- Print daily, weekly, and monthly token usage receipts with quick date navigation.
- Render a stepped receipt-printer feed animation with a torn paper edge, barcode, and `prefers-reduced-motion` support.
- Estimate model and token-category costs from the public [models.dev](https://models.dev) catalog across input, output, cache read, and cache write tokens, including built-in gateway route mappings and peak-hour adjustments.
- Match the default currency to the interface language, with manual switching between `USD`, `CNY`, and `JPY` and status notes for unpriced, partial, or cached rates.
- Export receipts as 3x high-resolution PNG images or print and save to PDF through the system print dialog.
- Support English, Simplified Chinese, and Japanese interfaces across light and dark themes.
