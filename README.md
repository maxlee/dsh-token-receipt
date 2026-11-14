<div align="center">
  <img src="icon.svg" width="64" height="64" alt="Token Receipt" />
  <h1>Token Receipt</h1>
  <p>Print daily, weekly, and monthly DeepSeek Harness token usage and estimated model costs as a tactile receipt.</p>
  <p>
    <a href="https://www.npmjs.com/package/dsh-token-receipt"><img src="https://img.shields.io/npm/v/dsh-token-receipt.svg" alt="npm version" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license" /></a>
    <a href="https://github.com/maxlee/dsh-token-receipt/actions/workflows/ci.yml"><img src="https://github.com/maxlee/dsh-token-receipt/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
    <img src="https://img.shields.io/badge/DSH-%3E%3D0.2.2--rc.3-4c8bf5.svg" alt="DSH >=0.2.2-rc.3" />
  </p>
  <p>
    <strong>English</strong> · <a href="README.zh.md">简体中文</a> · <a href="README.ja.md">日本語</a>
  </p>
</div>

| Dark · Daily | Light · Monthly |
| :---: | :---: |
| ![Token Receipt dark theme daily view](assets/screenshots/dark.png) | ![Token Receipt light theme monthly view](assets/screenshots/light.png) |

## Features

Token Receipt turns local DeepSeek Harness usage records into a printable receipt:

- **Period navigation.** View daily, weekly, or monthly bills and step across dates without leaving the panel.
- **Estimated model costs.** Break down spending per model across input, output, cache read, and cache write tokens using public [models.dev](https://models.dev) rates.
- **Multi-currency display.** Match the default currency to your interface language, or switch manually between `USD`, `CNY`, and `JPY`.
- **Tactile receipt feed.** Watch a stepped paper-feed animation with a torn paper edge and a barcode, with automatic `prefers-reduced-motion` support.
- **High-DPI export and print.** Save the receipt as a 3x PNG image, or print and export to PDF through your system print dialog.
- **Multilingual themes.** Use the interface in English, Simplified Chinese, or Japanese across light and dark themes.

> [!NOTE]
> Displayed costs are reference estimates calculated from public [models.dev](https://models.dev) catalog rates, not provider invoices. All session and token usage data stays local on your device, and only public price rates are fetched online.

## Installation

### Install from npm

Open **Plugins** in DeepSeek Harness, click **Add plugin**, and enter:

```text
dsh-token-receipt
```

Or install with the `plugin_manager` tool:

```json
{
	"action": "install_bundle",
	"target": "dsh-token-receipt"
}
```

### Install from a local checkout

Pass the local repository path to `plugin_manager`:

```json
{
	"action": "install_bundle",
	"target": "/absolute/path/to/dsh-token-receipt"
}
```

If DeepSeek Harness reports `restart-required`, restart the app once to activate the plugin.

## Usage

1. Open **Token receipt** from the left sidebar.
2. Select **Day**, **Week**, or **Month**, and use the date controls to move between periods.
3. Choose `USD`, `CNY`, `JPY`, or **Follow language** in the **Currency** menu.
4. Click **Save PNG** to download a 3x receipt image, **Print / PDF** to print or save a PDF, or **Replay print** to run the paper-feed animation again.

## Compatibility and development

Token Receipt requires the following runtime versions:

- DeepSeek Harness `>=0.2.2-rc.3 <0.3.0`
- Node.js `^22.19.0 || >=24.0.0`

Run syntax checks and the test suite from a local checkout:

```bash
npm run check && npm test
```

## License

Licensed under the [MIT License](LICENSE).

Receipt printer interaction inspired by [dqnamo's Receipt Printer](https://www.dqnamo.com/experiments/receipt-printer), with pricing resolution adapted from [dsh-context](https://github.com/bowenliang123/dsh-context). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for Apache-2.0 and SIL Open Font License 1.1 notices.
