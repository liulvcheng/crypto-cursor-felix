# Felix / HyperEVM 监控设计说明

## 目标

脚本面向单个 Felix 借贷池和单个钱包地址，提供一次性快照监控，不依赖私钥，只读链上数据。

## 当前默认配置

- `USER_ADDRESS`: `0xc69eC94F3dcE57B622D790E773899bc1d11A8074`
- `HYPER_EVM_RPC`: `https://rpc.hyperliquid.xyz/evm`
- `FELIX_MARKET`: `0x68e37de8d93d3496ae143f2e900490f6280c57cd`
- `FELIX_POOL_ID`: `0x85e7ea4f16f2299a2e50a650164c4ca3a01d4892c66950e4c9c7863dc79e9ea4`
- `loanToken`: `0x111111a1a0667d36bD57c0A9f569b98057111111`
- `collateralToken`: `0x5555555555555555555555555555555555555555`
- `oracle`: `0x72f82357dc9916ef419fAe30eaE44b0899668474`
- `irm`: `0xD4a426F010986dCad727e8dd6eed44cA4A9b7483`

## 链上读取对象

- `market.idToMarketParams(poolId)`: 获取 loan token、collateral token、oracle、IRM、LLTV
- `market.market(poolId)`: 获取池子的总借款和总份额
- `market.position(poolId, user)`: 获取用户的 `borrowShares` 和 `collateral`
- `oracle.price()`: 获取抵押资产对借款资产的报价，按 `1e36` 缩放
- `irm.borrowRateView(marketParams, market)`: 获取借款秒级利率，按 `1e18` 缩放

## 核心公式

### 抵押价值

```text
collateralValueInLoanAssets = collateralAssets * price / 1e36
```

### 借款价值

```text
borrowAssets = borrowShares * totalBorrowAssets / totalBorrowShares
```

### 协议上限下的最大可借

```text
maxBorrowAssets = collateralValueInLoanAssets * lltv / 1e18
```

### 健康因子

```text
healthFactor = maxBorrowAssets / borrowAssets
```

这里的健康因子是监控用途的粗略指标，不等同于协议实际清算线。

### 借款年化

```text
apr = ratePerSecondWad * secondsPerYear / 1e18
apy = (1 + apr / 365) ^ 365 - 1
```

## 设计决策

- 配置支持环境变量覆盖，默认值保留在代码中方便直接运行
- 即使本地预期地址过期，脚本仍以链上 `MarketParams` 返回的 oracle 和 IRM 为准继续计算
- 对市场参数不一致的情况只告警，不直接退出，避免因为地址升级导致监控静默失效
- Telegram 使用纯文本消息，减少 Markdown 转义带来的发送失败
- 核心纯函数暴露给测试，便于回归验证
