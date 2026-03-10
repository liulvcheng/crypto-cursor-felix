import { Contract, JsonRpcProvider, formatUnits, getAddress, isAddress } from "ethers";

// 默认直接监控当前这条 Felix 池子；需要切池子时优先改环境变量。
const DEFAULT_CONFIG = Object.freeze({
  userAddress: "0xc69eC94F3dcE57B622D790E773899bc1d11A8074",
  rpcUrl: "https://rpc.hyperliquid.xyz/evm",
  marketAddress: "0x68e37de8d93d3496ae143f2e900490f6280c57cd",
  poolId: "0x85e7ea4f16f2299a2e50a650164c4ca3a01d4892c66950e4c9c7863dc79e9ea4",
  expectedMarketParams: Object.freeze({
    loanToken: "0x111111a1a0667d36bD57c0A9f569b98057111111",
    collateralToken: "0x5555555555555555555555555555555555555555",
    oracle: "0x72f82357dc9916ef419fAe30eaE44b0899668474",
    irm: "0xD4a426F010986dCad727e8dd6eed44cA4A9b7483",
  }),
});

const ORACLE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;
const TELEGRAM_TIMEOUT_MS = 10_000;

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const ORACLE_ABI = [
  "function price() view returns (uint256)",
];

const MARKET_ABI = [
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
];

const IRM_ABI = [
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
];

function normalizeAddress(value, label) {
  if (!value || !isAddress(value)) {
    throw new Error(`Invalid ${label}: ${value ?? "<empty>"}`);
  }

  return getAddress(value);
}

function normalizeBytes32(value, label) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value ?? "")) {
    throw new Error(`Invalid ${label}: ${value ?? "<empty>"}`);
  }

  return value.toLowerCase();
}

function readOptionalEnv(env, key) {
  return env[key]?.trim() || "";
}

function loadConfig(env = process.env) {
  return {
    userAddress: normalizeAddress(env.USER_ADDRESS || DEFAULT_CONFIG.userAddress, "USER_ADDRESS"),
    rpcUrl: readOptionalEnv(env, "HYPER_EVM_RPC") || DEFAULT_CONFIG.rpcUrl,
    marketAddress: normalizeAddress(
      env.FELIX_MARKET || DEFAULT_CONFIG.marketAddress,
      "FELIX_MARKET"
    ),
    poolId: normalizeBytes32(env.FELIX_POOL_ID || DEFAULT_CONFIG.poolId, "FELIX_POOL_ID"),
    expectedMarketParams: {
      loanToken: normalizeAddress(
        env.USDH_TOKEN || DEFAULT_CONFIG.expectedMarketParams.loanToken,
        "USDH_TOKEN"
      ),
      collateralToken: normalizeAddress(
        env.HYPE_TOKEN || DEFAULT_CONFIG.expectedMarketParams.collateralToken,
        "HYPE_TOKEN"
      ),
      oracle: normalizeAddress(
        env.ORACLE || DEFAULT_CONFIG.expectedMarketParams.oracle,
        "ORACLE"
      ),
      irm: normalizeAddress(env.IRM || DEFAULT_CONFIG.expectedMarketParams.irm, "IRM"),
    },
    telegram: {
      botToken: readOptionalEnv(env, "TELEGRAM_BOT_TOKEN"),
      chatId: readOptionalEnv(env, "TELEGRAM_CHAT_ID"),
    },
  };
}

function mulDivDown(a, b, denominator) {
  if (denominator === 0n) {
    throw new Error("mulDivDown: division by zero");
  }

  return (a * b) / denominator;
}

function toPercentString(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `${(value * 100).toFixed(digits)}%`;
}

function formatTokenAmount(value, decimals, digits = 4) {
  const numericValue = Number.parseFloat(formatUnits(value, decimals));

  return Number.isFinite(numericValue)
    ? numericValue.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      })
    : formatUnits(value, decimals);
}

function formatUsdValue(rawAmount, decimals, digits = 2) {
  const numericValue = Number.parseFloat(formatUnits(rawAmount, decimals));

  return Number.isFinite(numericValue)
    ? numericValue.toLocaleString("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: digits,
      })
    : formatUnits(rawAmount, decimals);
}

function shortAddress(address) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function getHealthFactor(maxBorrowAssets, borrowAssets) {
  if (borrowAssets === 0n) {
    return Infinity;
  }

  return Number((maxBorrowAssets * 10_000n) / borrowAssets) / 10_000;
}

function getRiskAssessment(utilization, healthFactor) {
  if (
    utilization > 0.75 ||
    (Number.isFinite(healthFactor) && healthFactor < 1.3)
  ) {
    return "⚠️ 风险偏高，建议减仓或补充抵押";
  }

  if (
    utilization > 0.6 ||
    (Number.isFinite(healthFactor) && healthFactor < 1.6)
  ) {
    return "🟡 风险中等，注意价格波动";
  }

  return "✅ 风险较低";
}

function findMarketParamMismatches(actual, expected) {
  const fields = [
    ["loanToken", actual.loanToken, expected.loanToken],
    ["collateralToken", actual.collateralToken, expected.collateralToken],
    ["oracle", actual.oracle, expected.oracle],
    ["irm", actual.irm, expected.irm],
  ];

  return fields
    .filter(([, currentValue, expectedValue]) => currentValue !== expectedValue)
    .map(([field, currentValue, expectedValue]) => ({
      field,
      currentValue,
      expectedValue,
    }));
}

async function fetchTokenMetadata(tokenAddress, provider) {
  const token = new Contract(tokenAddress, ERC20_ABI, provider);

  try {
    const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);

    return { symbol, decimals };
  } catch {
    // 有些代币合约不一定完整实现 symbol/decimals，展示时退化成地址缩写。
    return {
      symbol: shortAddress(tokenAddress),
      decimals: 18,
    };
  }
}

function buildMarketParamsTuple(marketParams) {
  return [
    marketParams.loanToken,
    marketParams.collateralToken,
    marketParams.oracle,
    marketParams.irm,
    marketParams.lltv,
  ];
}

function buildMarketTuple(marketData) {
  return [
    marketData.totalSupplyAssets,
    marketData.totalSupplyShares,
    marketData.totalBorrowAssets,
    marketData.totalBorrowShares,
    marketData.lastUpdate,
    marketData.fee,
  ];
}

async function fetchPositionSnapshot(provider, config) {
  const market = new Contract(config.marketAddress, MARKET_ABI, provider);

  // Felix 的核心输入都来自 market 合约：池子参数、池子状态、用户仓位。
  const [marketParams, marketData, position] = await Promise.all([
    market.idToMarketParams(config.poolId),
    market.market(config.poolId),
    market.position(config.poolId, config.userAddress),
  ]);

  const normalizedMarketParams = {
    loanToken: getAddress(marketParams.loanToken),
    collateralToken: getAddress(marketParams.collateralToken),
    oracle: getAddress(marketParams.oracle),
    irm: getAddress(marketParams.irm),
    lltv: marketParams.lltv,
  };

  const mismatches = findMarketParamMismatches(
    normalizedMarketParams,
    config.expectedMarketParams
  );

  const loanToken = fetchTokenMetadata(normalizedMarketParams.loanToken, provider);
  const collateralToken = fetchTokenMetadata(
    normalizedMarketParams.collateralToken,
    provider
  );
  const oracle = new Contract(normalizedMarketParams.oracle, ORACLE_ABI, provider);
  const irm = new Contract(normalizedMarketParams.irm, IRM_ABI, provider);

  const [loanMetadata, collateralMetadata, price, ratePerSecondWad] = await Promise.all([
    loanToken,
    collateralToken,
    oracle.price(),
    irm.borrowRateView(
      buildMarketParamsTuple(normalizedMarketParams),
      buildMarketTuple(marketData)
    ),
  ]);

  const borrowAssets =
    marketData.totalBorrowShares === 0n
      ? 0n
      : mulDivDown(
          position.borrowShares,
          marketData.totalBorrowAssets,
          marketData.totalBorrowShares
        );
  const collateralAssets = position.collateral;
  // oracle.price() 的含义是 “1 collateral = 多少 loan”，精度是 1e36。
  const collateralValueInLoanAssets = mulDivDown(
    collateralAssets,
    price,
    ORACLE_SCALE
  );
  // lltv 是协议允许的最大借款比例，WAD 精度是 1e18。
  const maxBorrowAssets = mulDivDown(
    collateralValueInLoanAssets,
    normalizedMarketParams.lltv,
    WAD
  );
  const healthFactor = getHealthFactor(maxBorrowAssets, borrowAssets);

  // borrowRateView 返回秒级利率，按 1e18 缩放，这里再换成年化。
  const apr = Number.parseFloat(
    formatUnits(ratePerSecondWad * SECONDS_PER_YEAR, 18)
  );
  const apy = Number.isFinite(apr) ? Math.pow(1 + apr / 365, 365) - 1 : NaN;
  const collateralUsd = Number.parseFloat(
    formatUnits(collateralValueInLoanAssets, loanMetadata.decimals)
  );
  const debtUsd = Number.parseFloat(formatUnits(borrowAssets, loanMetadata.decimals));
  const utilization = collateralUsd > 0 ? debtUsd / collateralUsd : 0;

  return {
    mismatches,
    marketParams: normalizedMarketParams,
    loanMetadata,
    collateralMetadata,
    collateralAssets,
    borrowAssets,
    collateralValueInLoanAssets,
    utilization,
    healthFactor,
    borrowApr: apr,
    borrowApy: apy,
    riskLevel: getRiskAssessment(utilization, healthFactor),
  };
}

function buildConsoleLines(snapshot, config, now, blockNumber) {
  const healthFactor = Number.isFinite(snapshot.healthFactor)
    ? snapshot.healthFactor.toFixed(4)
    : "∞";

  return [
    `[INFO ] ${now} - Felix / HyperEVM 仓位监控脚本启动`,
    `[INFO ] ${now} - 使用 RPC: ${config.rpcUrl}`,
    `[INFO ] ${now} - 钱包地址: ${config.userAddress}`,
    `[INFO ] ${now} - Pool ID : ${config.poolId.slice(0, 12)}...`,
    `[INFO ] ${now} - 已连接到 HyperEVM，当前区块高度: ${blockNumber.toString()}`,
    "",
    "==============================================",
    " Felix / HyperEVM 抵押借款仓位监控结果",
    "==============================================",
    ` 抵押品数量       : ${formatTokenAmount(snapshot.collateralAssets, snapshot.collateralMetadata.decimals)} ${snapshot.collateralMetadata.symbol}`,
    ` 抵押品总价值 USD : $${formatUsdValue(snapshot.collateralValueInLoanAssets, snapshot.loanMetadata.decimals)}`,
    ` 借款总价值 USD   : $${formatUsdValue(snapshot.borrowAssets, snapshot.loanMetadata.decimals)}`,
    ` 仓位利用率       : ${toPercentString(snapshot.utilization)}`,
    ` LTV（协议上限）  : ${toPercentString(Number(snapshot.marketParams.lltv) / 1e18)}`,
    ` 健康因子         : ${healthFactor}`,
    ` 借款 APY (估算)  : ${toPercentString(snapshot.borrowApy)}  (APR ${toPercentString(snapshot.borrowApr)})`,
    "----------------------------------------------",
    ` 风险评估         : ${snapshot.riskLevel}`,
    "==============================================",
  ];
}

function buildTelegramMessage(snapshot, config, now) {
  const healthFactor = Number.isFinite(snapshot.healthFactor)
    ? snapshot.healthFactor.toFixed(4)
    : "∞";

  return [
    "Felix / HyperEVM 抵押借款仓位监控",
    "",
    `时间: ${now}`,
    `钱包: ${shortAddress(config.userAddress)}`,
    `池子: ${config.poolId.slice(0, 10)}...`,
    "",
    `抵押品: ${formatTokenAmount(snapshot.collateralAssets, snapshot.collateralMetadata.decimals)} ${snapshot.collateralMetadata.symbol} ($${formatUsdValue(snapshot.collateralValueInLoanAssets, snapshot.loanMetadata.decimals)})`,
    `借款: $${formatUsdValue(snapshot.borrowAssets, snapshot.loanMetadata.decimals)} ${snapshot.loanMetadata.symbol}`,
    `利用率: ${toPercentString(snapshot.utilization)}`,
    `LTV 上限: ${toPercentString(Number(snapshot.marketParams.lltv) / 1e18)}`,
    `健康因子: ${healthFactor}`,
    `借款 APY(估): ${toPercentString(snapshot.borrowApy)} (APR ${toPercentString(snapshot.borrowApr)})`,
    `风险评估: ${snapshot.riskLevel}`,
  ].join("\n");
}

async function sendTelegramMessage(text, telegramConfig) {
  if (!telegramConfig.botToken || !telegramConfig.chatId) {
    console.warn(
      "[WARN ] 未配置 TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID，跳过 Telegram 推送"
    );
    return;
  }

  if (typeof fetch !== "function") {
    throw new Error("Global fetch is unavailable. Please use Node.js 18 or newer.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${telegramConfig.botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: telegramConfig.chatId,
        text,
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    }
  );

  if (!response.ok) {
    const responseBody = await response.text().catch(() => "");
    console.warn(
      `[WARN ] Telegram 发送失败: ${response.status} ${response.statusText} ${responseBody}`
    );
    return;
  }

  console.log("[INFO ] 已发送监控结果到 Telegram");
}

async function main() {
  const config = loadConfig();
  const provider = new JsonRpcProvider(config.rpcUrl);

  try {
    const [blockNumber, snapshot] = await Promise.all([
      provider.getBlockNumber(),
      fetchPositionSnapshot(provider, config),
    ]);
    const now = new Date().toISOString();

    if (snapshot.mismatches.length > 0) {
      // 这里只告警不退出，避免 Felix 升级地址后监控直接中断。
      for (const mismatch of snapshot.mismatches) {
        console.warn(
          `[WARN ] MarketParams mismatch for ${mismatch.field}: expected ${mismatch.expectedValue}, got ${mismatch.currentValue}`
        );
      }
    }

    for (const line of buildConsoleLines(snapshot, config, now, blockNumber)) {
      console.log(line);
    }

    await sendTelegramMessage(
      buildTelegramMessage(snapshot, config, now),
      config.telegram
    );
  } finally {
    provider.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exit(1);
  });
}

export {
  buildConsoleLines,
  buildTelegramMessage,
  fetchPositionSnapshot,
  getHealthFactor,
  getRiskAssessment,
  loadConfig,
  main,
  normalizeBytes32,
  toPercentString,
};
