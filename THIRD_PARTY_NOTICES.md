# Third-party notices

## dsh-context

Parts of `pricing.js` are adapted from [dsh-context](https://github.com/bowenliang123/dsh-context) at commit `d81325ec6bab9dae9bf83e7a866ac74119504e18`:

- `src/shared/pricing.ts`
- `src/shared/priceIdentity.ts`
- `src/shared/providers.ts`

Copyright 2025 bowenliang123.

These portions are licensed under the Apache License, Version 2.0. See [`licenses/dsh-context-LICENSE.txt`](licenses/dsh-context-LICENSE.txt) for the full upstream license text and copyright notice. The upstream repository did not include a separate `NOTICE` file at that commit.

`pricing.js` converts the TypeScript resolver into a standalone JavaScript module and adds an activation-scoped price catalog, built-in route mappings for compatible gateways, time-of-day peak and off-peak pricing, and USD cost breakdowns.

The rest of Token Receipt remains under the MIT License in [`LICENSE`](LICENSE). These notices do not alter the license of the upstream portions.

## Embedded fonts

`client.js` embeds two open-source typefaces under the SIL Open Font License, Version 1.1:

- **[Inter](https://github.com/rsms/inter).** Copyright 2016 The Inter Project Authors. Licensed under the SIL Open Font License 1.1. Full license text in [`licenses/Inter-OFL.txt`](licenses/Inter-OFL.txt).
- **[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono).** Copyright 2020 The JetBrains Mono Project Authors. Licensed under the SIL Open Font License 1.1. Full license text in [`licenses/JetBrainsMono-OFL.txt`](licenses/JetBrainsMono-OFL.txt).

## Model price data

Token Receipt fetches reference model rates at runtime from [models.dev](https://models.dev/api.json), maintained at [`anomalyco/models.dev`](https://github.com/anomalyco/models.dev). This package does not bundle a copied model catalog. Displayed amounts are reference estimates and may differ from provider invoices, subscription plans, or custom pricing terms.
