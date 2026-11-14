# Third-party notices

## dsh-context

Parts of `pricing.js` are adapted from the following files in
[dsh-context](https://github.com/bowenliang123/dsh-context), commit
`d81325ec6bab9dae9bf83e7a866ac74119504e18`:

- `src/shared/pricing.ts`
- `src/shared/priceIdentity.ts`
- `src/shared/providers.ts`

Copyright 2025 bowenliang123.

These portions are licensed under the Apache License, Version 2.0. A complete
copy of the upstream license, including its copyright notice, is provided in
[`licenses/dsh-context-LICENSE.txt`](licenses/dsh-context-LICENSE.txt).
The upstream repository did not contain a separate NOTICE file at that commit.

The adapted file prominently records its modifications: the TypeScript
resolver was converted to a self-contained JavaScript module; Token Receipt
adds an activation-scoped price catalog, an explicit user-requested WorkBuddy
Flash reference-price override, per-message peak/off-peak pricing, and USD
amount breakdowns. The override is marked `user-override` in API responses.

The rest of Token Receipt remains under the repository's MIT license. These
notices do not change the license of the upstream portions.

## Model price data

Reference model rates are fetched at runtime from
[models.dev](https://models.dev/api.json). The model directory and its data
sources are maintained by [models.dev](https://github.com/anomalyco/models.dev).
The plugin does not bundle a copied model catalogue. Rates are reference
estimates and may differ from invoices, subscription entitlements, and
provider-specific pricing conditions.
