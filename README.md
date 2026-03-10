# crypto-felix

用于监控 HyperEVM 上 Felix 借贷仓位的 Node.js 脚本。脚本直接读取链上 `market`、`position`、`oracle.price()` 和 `irm.borrowRateView()`，输出抵押价值、借款价值、利用率、健康因子和估算 APY，并可选推送到 Telegram。

## 功能

- 读取 Felix 池子的 `MarketParams`、市场状态和用户仓位
- 自动把 `borrowShares` 换算为实际借款额
- 使用链上 oracle 价格计算抵押品的 USDH 计价价值
- 使用链上 IRM 计算借款 APR / APY
- 当链上市场参数和本地预期配置不一致时输出警告
- 支持通过环境变量覆盖默认配置
- 支持 Telegram 通知

## 环境要求

- Node.js 18 或更高版本
- 能访问 HyperEVM RPC

## 安装

```bash
npm install
```

## 运行

默认配置已经写入脚本，可直接执行：

```bash
npm start
```

如果你要覆盖默认配置，先设置环境变量：

```bash
export USER_ADDRESS=0x...
export HYPER_EVM_RPC=https://rpc.hyperliquid.xyz/evm
export FELIX_MARKET=0x...
export FELIX_POOL_ID=0x...
export USDH_TOKEN=0x...
export HYPE_TOKEN=0x...
export ORACLE=0x...
export IRM=0x...
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHAT_ID=...
npm start
```

## 可用脚本

- `npm start`: 执行监控脚本
- `npm run check`: 校验脚本语法
- `npm test`: 运行纯函数测试

## 输出说明

- `抵押品总价值 USD`: 按 `oracle.price()` 把抵押资产换算为 loan token 计价，当前池中约等于 USD
- `借款总价值 USD`: 由 `borrowShares * totalBorrowAssets / totalBorrowShares` 推导
- `健康因子`: 使用 `maxBorrow / currentBorrow` 粗略表示离协议上限还有多远
- `借款 APY (估算)`: 根据 `borrowRateView()` 的秒级利率换算

## Telegram

设置 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID` 后，脚本会在每次运行完成后发送一条纯文本通知。如果未设置，这一步会被安全跳过。

## GitHub Actions

仓库内置了 [`.github/workflows/felix-telegram.yml`](/Users/stock2flow/Dev/Cursor/crypto-felix/.github/workflows/felix-telegram.yml)，默认按定时任务执行 `npm start`。要启用 Telegram 推送，需要在仓库 Secrets 中配置：

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## 项目结构

- [`monitor-felix.js`](/Users/stock2flow/Dev/Cursor/crypto-felix/monitor-felix.js): 主脚本
- [`monitor-felix.test.js`](/Users/stock2flow/Dev/Cursor/crypto-felix/monitor-felix.test.js): 基础测试
- [`plan.md`](/Users/stock2flow/Dev/Cursor/crypto-felix/plan.md): 公式、链上对象和设计说明
