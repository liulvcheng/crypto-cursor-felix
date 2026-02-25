Felix / HyperEVM 仓位监控文档
================================

这份文档配合同级目录下的 `monitor-felix.js` 使用，用来：

- 记录你现在已知的信息（钱包、poolId、链）
- 记录已经确认的 Felix / HyperEVM 合约地址
- 解释脚本大致在做什么

## 一、已知信息

- **钱包地址（你的）**: `0xc69eC94F3dcE57B622D790E773899bc1d11A8074`
- **Felix Vanilla Borrow 页面**: [`https://www.usefelix.xyz/vanilla/borrow`](https://www.usefelix.xyz/vanilla/borrow)
- **在 Felix 上的操作**: 抵押 HYPE，借出 USDH
- **流动性池子 ID（Felix 内部 ID）**:
  - `0x85e7ea4f16f2299a2e50a650164c4ca3a01d4892c66950e4c9c7863dc79e9ea4`
- **链**: HyperEVM

## 二、当前已确认的链与合约信息

部分信息已经从 HyperEVMScan / Felix 合约中确认，并直接写入 `monitor-felix.js`：

1. **HyperEVM 的正式 RPC**
   - 当前使用: `https://rpc.hyperliquid.xyz/evm`

2. **Felix 在 HyperEVM 上与你这个池子相关的合约地址**
   - **USDH（loanToken）**: `0x111111a1a0667d36bD57c0A9f569b98057111111`
   - **HYPE 抵押 token（collateralToken）**: `0x5555555555555555555555555555555555555555`
   - **Felix 主市场合约（FELIX_MARKET）**: `0x68e37de8d93d3496ae143f2e900490f6280c57cd`
   - **Felix 多调用合约（FELIX_MULTICALL）**: `0xa3F50477AfA601C771874260A3B34B40e244Fa0e`
   - **价格预言机（PRICE_ORACLE，池子对应 oracle）**: `0x72f82357dc9916ef419fAe30eaE44b0899668474`
   - **利率模型合约（FELIX_IRM）**: `0xD4a426F010986dCad727e8dd6eed44cA4A9b7483`

目前脚本中：

- 已完全按 Felix / Morpho Blue 风格实现：`position` / `market` / `oracle.price()` / `irm.borrowRateView()`
- 不再需要 Aave 风格的 `LENDING_POOL` / `DATA_PROVIDER`

3. **Oracle 价格规则（关键）**

- `IOracle.price()` 返回：“1 collateral asset 以 loan asset 报价”的价格，按 `1e36` 缩放（`scaled by 1e36`）。
- 换算公式（链上 BigInt 安全计算）：

  ```text
  collateralValueInLoanAssets = collateralAssets * price / 1e36
  ```

- 由于本池 `loanToken = USDH`（稳定币），所以：
  - `collateralValueInLoanAssets`（以 USDH 计）≈ 抵押品 USD 价值

## 三、`monitor-felix.js` 做了什么

脚本的主要流程（都配有中文注释，直接看源码也能看懂）：

### 1）基础配置

- 设置你的钱包地址、HyperEVM RPC、Felix 合约地址、USDH token 地址  
- 这些值都在文件顶部的：
  - `USER_ADDRESS`
  - `HYPER_EVM_RPC`
  - `FELIX_MARKET`
  - `USDH_TOKEN`
  - `HYPE_TOKEN`
  - `ORACLE`
  - `IRM`
 里

### 2）核心 ABI（脚本只用最小集合）

- **Market（`FELIX_MARKET`）**
  - `position(id, user)`：拿到你的 `collateral`（抵押数量）和 `borrowShares`（债务份额）
  - `market(id)`：拿到 `totalBorrowAssets` / `totalBorrowShares`（把债务份额换成真实债务数量）
  - `idToMarketParams(id)`：拿到 `loanToken` / `collateralToken` / `oracle` / `irm` / `lltv`
- **Oracle（`PRICE_ORACLE`）**
  - `price()`：用于把 collateral 换算成 loan 计价（scaled `1e36`）
- **IRM（`FELIX_IRM`）**
  - `borrowRateView(marketParams, market)`：计算借款利率

### 3）仓位数值计算方式（你关心的 3 个指标）

- **抵押品价值（USD）**
  - `collateralAssets = position.collateral`
  - `price = oracle.price()`
  - `collateralValueInLoanAssets = collateralAssets * price / 1e36`
  - 因为 `loanToken = USDH`，所以 `collateralValueInLoanAssets（USDH）≈ USD`

- **借款价值（USD）**
  - `borrowAssets ~= borrowShares * totalBorrowAssets / totalBorrowShares`
  - 因为 `loanToken = USDH`，所以 `borrowAssets（USDH）≈ USD`

- **借款 APY**
  - `ratePerSecondWad = irm.borrowRateView(marketParams, market)`
  - `APR ~= ratePerSecondWad * secondsPerYear / 1e18`
  - `APY ~= (1 + APR/365)^365 - 1`

### 4）`main()`

- 连接 HyperEVM RPC，查询当前区块高度
- 调用 `fetchPositionSnapshot`，拿到：
  - 抵押数量 / 抵押价值（USDH ≈ USD）
  - 借款数量 / 借款价值（USDH ≈ USD）
  - 协议 LTV 上限（`lltv`）
  - 健康因子（`healthFactor`，基于 `lltv` 计算的“理论最大可借 / 实际借款”）
  - 借款 APR / APY（由 `IRM.borrowRateView` 推算）
- 根据利用率和健康因子做一个主观的风险分级（✅ / 🟡 / ⚠️）
- 最后打印成一段对齐好的中文汇总（见下方输出示例）

## 四、如何在 Terminal 中运行

前提：你电脑上已经装了 Node.js（推荐 >= 18，但 16+ 基本都可以）。

### 1）在项目根目录执行一次初始化（可选，如果你只用这个单文件可以跳过）

```bash
cd /Users/stock2flow/Dev/Cursor/crypto-felix
npm init -y
```

### 2）安装依赖（只需要一次）

```bash
cd /Users/stock2flow/Dev/Cursor/crypto-felix
npm install
```

### 3）确认你已经配置好合约地址

- 在 `monitor-felix.js` 顶部把：
  - `HYPER_EVM_RPC`
  - `FELIX_MARKET`
  - `USDH_TOKEN`
  - `HYPE_TOKEN`
  - `ORACLE`
  - `IRM`
- 都填成真实、已在 HyperEVMScan 验证过的地址

### 4）运行脚本

```bash
cd /Users/stock2flow/Dev/Cursor/crypto-felix
npm start
```

### 5）典型输出效果（示意）

```text
[INFO ] 2026-02-24T12:00:00.000Z - Felix / HyperEVM 仓位监控脚本启动
[INFO ] 2026-02-24T12:00:00.000Z - 使用 RPC: https://rpc.hyperliquid.xyz/evm
[INFO ] 2026-02-24T12:00:00.000Z - 钱包地址: 0xc69eC94F3dcE57B622D790E773899bc1d11A8074
[INFO ] 2026-02-24T12:00:00.000Z - Pool ID : 0x85e7ea4f16f2...
[INFO ] 2026-02-24T12:00:00.000Z - 已连接到 HyperEVM，当前区块高度: 1234567

==============================================
 Felix / HyperEVM 抵押借款仓位监控结果
==============================================
 抵押品数量       : 1234.5678 HYPE
 抵押品总价值 USD : $12345.67
 借款总价值 USD   : $4567.89
 仓位利用率       : 37.00%
 LTV（协议上限）  : 60.00%
 健康因子         : 2.3456
 借款 APY (估算)  : 4.80%  (APR 4.70%)
----------------------------------------------
 风险评估         : ✅ 风险较低
==============================================
```

## 五、后续可以扩展的方向

1. 设置定时器，每 5 分钟跑一次 `main()`，并把结果写到一个 JSON / CSV 文件里。
2. 集成 Telegram Bot / Discord Webhook，当 `healthFactor` 低于某个值时自动发消息。
3. 做一个简单的 Web Dashboard，把当前数值画成卡片或图表。

## 备注

- HYPE 的最小单位是 `1e18`（Wei 风格），可用 HyperEVMScan 的 unit converter 验证（例如：[unit converter 示例](https://hyperevmscan.io/unitconverter?wei=26780758914103382320274910)）。
