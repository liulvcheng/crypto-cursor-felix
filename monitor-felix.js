// Felix 借贷仓位监控脚本（HyperEVM / Felix / Morpho Blue 风格）
// 目标输出：
// - 抵押品价值（USDH 计价，≈ USD）
// - 借款价值（USDH）
// - 借款 APY（由 IRM.borrowRateView 计算）
//
// 你已提供的关键规则：
// - Oracle: `price()` 返回 “1 collateral asset 以 loan asset 报价” 的价格，按 1e36 缩放。
//   => collateralValueInLoanAssets = collateralAssets * price / 1e36
// - IRM: `borrowRateView(marketParams, market)` 返回借款利率。
//
// 注意：
// - 这个脚本只做只读查询，不需要私钥。
// - 价格与金额全部使用链上合约数据计算，不依赖网页抓包。

import { JsonRpcProvider, Contract, formatUnits } from "ethers";

// =============== 1) 固定配置（你这条池子已确认） ===============

const USER_ADDRESS = "0xc69eC94F3dcE57B622D790E773899bc1d11A8074";
const HYPER_EVM_RPC = "https://rpc.hyperliquid.xyz/evm";

// Felix/Morpho Blue 风格的主市场合约（包含 position/market/idToMarketParams）
const FELIX_MARKET = "0x68e37de8d93d3496ae143f2e900490f6280c57cd";

// 这条池子的 id（bytes32）
const FELIX_POOL_ID =
  "0x85e7ea4f16f2299a2e50a650164c4ca3a01d4892c66950e4c9c7863dc79e9ea4";

// 你已查到的 MarketParams（用于做 sanity check，也用于解释输出）
const USDH_TOKEN = "0x111111a1a0667d36bD57c0A9f569b98057111111"; // loanToken
const HYPE_TOKEN = "0x5555555555555555555555555555555555555555"; // collateralToken
const ORACLE = "0x72f82357dc9916ef419fAe30eaE44b0899668474";
const IRM = "0xD4a426F010986dCad727e8dd6eed44cA4A9b7483";

// 常量
const ORACLE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000n;

// =============== 2) 最小 ABI（只保留脚本用到的函数） ===============

const ERC20_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
];

// IOracle.sol：price() -> uint256（scaled 1e36）
const ORACLE_ABI = [
  {
    inputs: [],
    name: "price",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

// Morpho/Felix 市场合约（你给的 0x68e3... 里就有这些函数）
const MARKET_ABI = [
  {
    inputs: [{ internalType: "Id", name: "", type: "bytes32" }],
    name: "idToMarketParams",
    outputs: [
      { internalType: "address", name: "loanToken", type: "address" },
      { internalType: "address", name: "collateralToken", type: "address" },
      { internalType: "address", name: "oracle", type: "address" },
      { internalType: "address", name: "irm", type: "address" },
      { internalType: "uint256", name: "lltv", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "Id", name: "", type: "bytes32" }],
    name: "market",
    outputs: [
      { internalType: "uint128", name: "totalSupplyAssets", type: "uint128" },
      { internalType: "uint128", name: "totalSupplyShares", type: "uint128" },
      { internalType: "uint128", name: "totalBorrowAssets", type: "uint128" },
      { internalType: "uint128", name: "totalBorrowShares", type: "uint128" },
      { internalType: "uint128", name: "lastUpdate", type: "uint128" },
      { internalType: "uint128", name: "fee", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "Id", name: "", type: "bytes32" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "position",
    outputs: [
      { internalType: "uint256", name: "supplyShares", type: "uint256" },
      { internalType: "uint128", name: "borrowShares", type: "uint128" },
      { internalType: "uint128", name: "collateral", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
];

// 你提供的 IRM ABI：borrowRateView(marketParams, market) -> uint256
const IRM_ABI = [
  {
    inputs: [
      {
        components: [
          { internalType: "address", name: "loanToken", type: "address" },
          { internalType: "address", name: "collateralToken", type: "address" },
          { internalType: "address", name: "oracle", type: "address" },
          { internalType: "address", name: "irm", type: "address" },
          { internalType: "uint256", name: "lltv", type: "uint256" },
        ],
        internalType: "struct MarketParams",
        name: "marketParams",
        type: "tuple",
      },
      {
        components: [
          { internalType: "uint128", name: "totalSupplyAssets", type: "uint128" },
          { internalType: "uint128", name: "totalSupplyShares", type: "uint128" },
          { internalType: "uint128", name: "totalBorrowAssets", type: "uint128" },
          { internalType: "uint128", name: "totalBorrowShares", type: "uint128" },
          { internalType: "uint128", name: "lastUpdate", type: "uint128" },
          { internalType: "uint128", name: "fee", type: "uint128" },
        ],
        internalType: "struct Market",
        name: "market",
        type: "tuple",
      },
    ],
    name: "borrowRateView",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

// =============== 3) BigInt 小工具 ===============

function mulDivDown(a, b, den) {
  if (den === 0n) throw new Error("mulDivDown: division by zero");
  return (a * b) / den;
}

function toPctString(x, decimals = 2) {
  // x: 例如 0.1234 => "12.34%"
  if (!Number.isFinite(x)) return "N/A";
  return `${(x * 100).toFixed(decimals)}%`;
}

// =============== 4) 核心读取与计算 ===============

async function fetchPositionSnapshot(provider) {
  const market = new Contract(FELIX_MARKET, MARKET_ABI, provider);
  const oracle = new Contract(ORACLE, ORACLE_ABI, provider);
  const irm = new Contract(IRM, IRM_ABI, provider);

  // 1) 读取 MarketParams / Market / Position
  const [marketParams, marketData, pos] = await Promise.all([
    market.idToMarketParams(FELIX_POOL_ID),
    market.market(FELIX_POOL_ID),
    market.position(FELIX_POOL_ID, USER_ADDRESS),
  ]);

  // 2) sanity check：确保你监控的就是这条池子
  // （如果 Felix 升级/换池子，这里会提醒你）
  const mismatches = [];
  if (marketParams.loanToken.toLowerCase() !== USDH_TOKEN.toLowerCase()) mismatches.push("loanToken");
  if (marketParams.collateralToken.toLowerCase() !== HYPE_TOKEN.toLowerCase()) mismatches.push("collateralToken");
  if (marketParams.oracle.toLowerCase() !== ORACLE.toLowerCase()) mismatches.push("oracle");
  if (marketParams.irm.toLowerCase() !== IRM.toLowerCase()) mismatches.push("irm");

  // 3) token 元信息（仅用于展示）
  const loanErc20 = new Contract(marketParams.loanToken, ERC20_ABI, provider);
  const collatErc20 = new Contract(marketParams.collateralToken, ERC20_ABI, provider);
  const [[loanSymbol, loanDecimals], [collatSymbol, collatDecimals]] = await Promise.all([
    Promise.all([loanErc20.symbol(), loanErc20.decimals()]),
    Promise.all([collatErc20.symbol(), collatErc20.decimals()]),
  ]);

  // 4) 借款资产：borrowShares -> borrowAssets
  // 近似按“按比例”换算：borrowAssets ~= borrowShares * totalBorrowAssets / totalBorrowShares
  const borrowShares = pos.borrowShares; // bigint (v6)
  const totalBorrowAssets = marketData.totalBorrowAssets;
  const totalBorrowShares = marketData.totalBorrowShares;

  const borrowAssets =
    totalBorrowShares === 0n ? 0n : mulDivDown(borrowShares, totalBorrowAssets, totalBorrowShares);

  // 5) 抵押资产（collateral token 的最小单位）
  const collateralAssets = pos.collateral;

  // 6) Oracle 价格：collateral -> loan 计价（scaled 1e36）
  const price = await oracle.price(); // bigint
  const collateralValueInLoanAssets = mulDivDown(collateralAssets, price, ORACLE_SCALE);

  // 7) 健康因子（用 lltv 推 maxBorrow，注意：不是清算线，仅是 lltv 上限）
  const lltv = marketParams.lltv; // 例如 0.77e18
  const maxBorrowAssets = mulDivDown(collateralValueInLoanAssets, lltv, WAD);
  const healthFactor = borrowAssets === 0n ? Infinity : Number((maxBorrowAssets * 1_0000n) / borrowAssets) / 1_0000;

  // 8) 借款利率：IRM.borrowRateView
  // 这里按 Morpho Blue 常见约定，把 borrowRateView 当作 “每秒利率（WAD=1e18）”
  // 年化 APR = ratePerSecondWad * secondsPerYear / 1e18
  // ethers v6 返回的结构是只读 Result，需要显式转换成普通数组 tuple 再传给 IRM
  const marketParamsTuple = [
    marketParams.loanToken,
    marketParams.collateralToken,
    marketParams.oracle,
    marketParams.irm,
    marketParams.lltv,
  ];

  const marketDataTuple = [
    marketData.totalSupplyAssets,
    marketData.totalSupplyShares,
    marketData.totalBorrowAssets,
    marketData.totalBorrowShares,
    marketData.lastUpdate,
    marketData.fee,
  ];

  const ratePerSecondWad = await irm.borrowRateView(marketParamsTuple, marketDataTuple); // bigint
  const aprWad = mulDivDown(ratePerSecondWad, SECONDS_PER_YEAR, 1n); // 仍是 WAD 精度
  const apr = parseFloat(formatUnits(aprWad, 18)); // e.g. 0.05
  const apy = Math.pow(1 + apr / 365, 365) - 1;

  // 9) 展示用字符串（USDH ≈ USD）
  const collateralAmountStr = formatUnits(collateralAssets, collatDecimals);
  const debtAmountStr = formatUnits(borrowAssets, loanDecimals);
  const collateralUsdStr = formatUnits(collateralValueInLoanAssets, loanDecimals);
  const debtUsdStr = debtAmountStr;

  const collateralUsd = parseFloat(collateralUsdStr || "0");
  const debtUsd = parseFloat(debtUsdStr || "0");
  const utilization = collateralUsd > 0 ? debtUsd / collateralUsd : 0;

  return {
    mismatches,
    loanSymbol,
    collatSymbol,
    collateralAmountStr,
    debtAmountStr,
    collateralUsdStr,
    debtUsdStr,
    utilization,
    healthFactor,
    lltv,
    borrowApr: apr,
    borrowApy: apy,
  };
}

// =============== 5) main：美化终端输出 ===============

async function main() {
  const provider = new JsonRpcProvider(HYPER_EVM_RPC);
  const blockNumber = await provider.getBlockNumber();
  const now = new Date().toISOString();

  const snap = await fetchPositionSnapshot(provider);

  if (snap.mismatches.length) {
    console.log(`WARN: MarketParams mismatch: ${snap.mismatches.join(", ")} (池子可能变更/升级了)`);
  }

  const utilizationPct = toPctString(snap.utilization);
  const lltvPct = toPctString(Number(snap.lltv) / 1e18);
  const hfStr = Number.isFinite(snap.healthFactor) ? snap.healthFactor.toFixed(4) : "∞";

  // 简单风险评估（仅做主观参考）
  let riskLevel = "✅ 风险较低";
  if (snap.utilization > 0.75 || (Number.isFinite(snap.healthFactor) && snap.healthFactor < 1.3)) {
    riskLevel = "⚠️ 风险偏高，建议减仓或补充抵押";
  } else if (snap.utilization > 0.6 || (Number.isFinite(snap.healthFactor) && snap.healthFactor < 1.6)) {
    riskLevel = "🟡 风险中等，注意价格波动";
  }

  console.log(`[INFO ] ${now} - Felix / HyperEVM 仓位监控脚本启动`);
  console.log(`[INFO ] ${now} - 使用 RPC: ${HYPER_EVM_RPC}`);
  console.log(`[INFO ] ${now} - 钱包地址: ${USER_ADDRESS}`);
  console.log(`[INFO ] ${now} - Pool ID : ${FELIX_POOL_ID.slice(0, 12)}...`);
  console.log(
    `[INFO ] ${now} - 已连接到 HyperEVM，当前区块高度: ${blockNumber.toString()}`
  );

  console.log("");
  console.log("==============================================");
  console.log(" Felix / HyperEVM 抵押借款仓位监控结果");
  console.log("==============================================");
  console.log(` 抵押品数量       : ${snap.collateralAmountStr} ${snap.collatSymbol}`);
  console.log(` 抵押品总价值 USD : $${snap.collateralUsdStr}`);
  console.log(` 借款总价值 USD   : $${snap.debtUsdStr}`);
  console.log(` 仓位利用率       : ${utilizationPct}`);
  console.log(` LTV（协议上限）  : ${lltvPct}`);
  console.log(` 健康因子         : ${hfStr}`);
  console.log(
    ` 借款 APY (估算)  : ${toPctString(snap.borrowApy)}  (APR ${toPctString(
      snap.borrowApr
    )})`
  );
  console.log("----------------------------------------------");
  console.log(` 风险评估         : ${riskLevel}`);
  console.log("==============================================");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}

export { main };

