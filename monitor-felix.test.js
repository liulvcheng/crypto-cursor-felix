import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTelegramMessage,
  getHealthFactor,
  getRiskAssessment,
  loadConfig,
  normalizeBytes32,
  toPercentString,
} from "./monitor-felix.js";

test("loadConfig supports env overrides and normalizes addresses", () => {
  const config = loadConfig({
    USER_ADDRESS: "0xc69ec94f3dce57b622d790e773899bc1d11a8074",
    HYPER_EVM_RPC: "https://example-rpc.local",
    FELIX_MARKET: "0x68e37de8d93d3496ae143f2e900490f6280c57cd",
    FELIX_POOL_ID:
      "0x85e7ea4f16f2299a2e50a650164c4ca3a01d4892c66950e4c9c7863dc79e9ea4",
    USDH_TOKEN: "0x111111a1a0667d36bd57c0a9f569b98057111111",
    HYPE_TOKEN: "0x5555555555555555555555555555555555555555",
    ORACLE: "0x72f82357dc9916ef419fae30eae44b0899668474",
    IRM: "0xd4a426f010986dcad727e8dd6eed44ca4a9b7483",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "chat-id",
  });

  assert.equal(config.rpcUrl, "https://example-rpc.local");
  assert.equal(config.telegram.botToken, "bot-token");
  assert.equal(config.telegram.chatId, "chat-id");
  assert.equal(config.userAddress, "0xc69eC94F3dcE57B622D790E773899bc1d11A8074");
});

test("normalizeBytes32 validates pool ids", () => {
  assert.equal(
    normalizeBytes32(
      "0x85E7EA4F16F2299A2E50A650164C4CA3A01D4892C66950E4C9C7863DC79E9EA4",
      "FELIX_POOL_ID"
    ),
    "0x85e7ea4f16f2299a2e50a650164c4ca3a01d4892c66950e4c9c7863dc79e9ea4"
  );

  assert.throws(
    () => normalizeBytes32("0x1234", "FELIX_POOL_ID"),
    /Invalid FELIX_POOL_ID/
  );
});

test("risk helpers produce stable thresholds", () => {
  assert.equal(getHealthFactor(200n, 100n), 2);
  assert.equal(getRiskAssessment(0.2, 2), "✅ 风险较低");
  assert.equal(getRiskAssessment(0.61, 1.7), "🟡 风险中等，注意价格波动");
  assert.equal(getRiskAssessment(0.8, 1.8), "⚠️ 风险偏高，建议减仓或补充抵押");
});

test("format helpers return readable output", () => {
  assert.equal(toPercentString(0.1234), "12.34%");
  assert.equal(toPercentString(Infinity), "N/A");
});

test("telegram message builder includes the key metrics", () => {
  const text = buildTelegramMessage(
    {
      collateralAssets: 1250000000000000000n,
      borrowAssets: 350000000000000000n,
      collateralValueInLoanAssets: 2500000000000000000n,
      utilization: 0.14,
      healthFactor: 3.21,
      borrowApr: 0.051,
      borrowApy: 0.0523,
      riskLevel: "✅ 风险较低",
      marketParams: {
        lltv: 700000000000000000n,
      },
      loanMetadata: {
        symbol: "USDH",
        decimals: 18,
      },
      collateralMetadata: {
        symbol: "HYPE",
        decimals: 18,
      },
    },
    {
      userAddress: "0xc69eC94F3dcE57B622D790E773899bc1d11A8074",
      poolId:
        "0x85e7ea4f16f2299a2e50a650164c4ca3a01d4892c66950e4c9c7863dc79e9ea4",
    },
    "2026-03-10T12:00:00.000Z"
  );

  assert.match(text, /Felix \/ HyperEVM 抵押借款仓位监控/);
  assert.match(text, /借款 APY\(估\): 5\.23%/);
  assert.match(text, /风险评估: ✅ 风险较低/);
});
