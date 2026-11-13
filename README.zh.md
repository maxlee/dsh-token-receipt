# Token 账单 · DeepSeek Harness 插件

[![npm 版本](https://img.shields.io/npm/v/@maxlee/dsh-token-receipt.svg)](https://www.npmjs.com/package/@maxlee/dsh-token-receipt)
[![许可证](https://img.shields.io/npm/l/@maxlee/dsh-token-receipt.svg)](LICENSE)

把日、周、月的 token 用量打印成一张有手感的小票：阶梯送纸、撕边、条形码，
打印完成后可保存为 PNG，也可以走系统打印 / PDF。

[English](README.md)

![深色主题下的 Token 账单](docs/screenshots/dark.png)

## 功能

- **日 / 周 / 月账单**：同一个页面切换周期，向前或向后翻查。
- **小票打印机动画**：整理用量 → 阶梯送纸 → 打印完成，参考 dqnamo 的
  Receipt Printer 实验。
- **保存 PNG**：按 3 倍分辨率导出当前小票图片。
- **打印 / PDF**：调用系统打印对话框，打印样式只输出小票。
- **只读本地数据**：从本机 DSH 会话记录读取 token 用量，不会发送到任何地方。
- 支持浅色 / 深色主题、中英文界面和 reduced-motion。

![浅色主题下的 Token 账单](docs/screenshots/light.png)

## 安装

### 从 npm 安装（推荐）

在 DeepSeek Harness 中打开 **Plugins → Add plugin**，输入：

```text
@maxlee/dsh-token-receipt
```

也可以使用 DSH 的 `plugin_manager` 工具：

```json
{
  "action": "install_bundle",
  "target": "@maxlee/dsh-token-receipt@1.0.0"
}
```

安装后，在左侧栏打开「Token 账单」。如果 DSH 提示 `restart-required`，
重启一次应用即可。

### 从本地目录安装

```text
plugin_manager install_bundle
target: /absolute/path/to/dsh-token-receipt
```

## 使用

1. 左侧栏打开「Token 账单」。
2. 选择 **日 / 周 / 月**，或点日期选择器跳到某一天。
3. 第一次打开会自动播放一次打印动画；点「重播打印」可再次播放。
4. 「保存 PNG」会把高分辨率小票下载到本地。
5. 「打印 / PDF」会打开系统打印对话框。

![月账单](docs/screenshots/month.png)

## 数据与隐私

插件通过 DSH 的本地会话记录读取 token 用量，不发送任何会话数据；只统计
记录了 `usage` 的消息，不会估算没有 usage 元数据的旧消息，也不计算金额。

## 兼容性

- DeepSeek Harness `>=0.2.2-rc.3 <0.3.0`
- Node.js `^22.19.0 || >=24.0.0`

## 开发

```bash
node --check index.js
node --check client.js
npm pack --dry-run
```

插件没有运行时 npm 依赖。字体以 base64 内嵌在客户端 bundle 中：
Inter 与 JetBrains Mono，均为 SIL Open Font License 1.1，详见
[docs/FONTS.md](docs/FONTS.md)。

## 致谢

小票打印机的交互参考了
[dqnamo Receipt Printer](https://www.dqnamo.com/experiments/receipt-printer)；
本仓库是独立实现，内置纹理由程序化 SVG 生成。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
