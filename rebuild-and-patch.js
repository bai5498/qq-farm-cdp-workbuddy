/**
 * 重建 qq-farm bundle 并 patch 到小游戏 game.js
 *
 * 流程：
 * 1. 读取修改后的 qq-host.js + button.js 构建新 bundle
 * 2. 将新 bundle patch 到小游戏 game.js 中
 *
 * 前置条件：cdp-auto 已停掉（否则 game.js 会被锁）
 */
"use strict";

const { buildQqBundle, patchQqGameFile } = require("./src/qq-bundle");
const path = require("path");

const MINIAPP_GAME_JS = "C:\\Users\\54988\\AppData\\Roaming\\QQEX\\miniapp\\temps\\miniapp_src\\1112386029_3_893ba9a3468620092c92e0dce066d0d4\\game.js";
const MINIAPP_ID = "1112386029_3_893ba9a3468620092c92e0dce066d0d4";

async function main() {
  console.log("🔨 步骤1: 构建 bundle（包含修改后的 qq-host.js）...\n");

  const bundle = buildQqBundle({
    projectRoot: path.join(__dirname),
    config: {},
    hostVersion: "qq-host-probe-v1",
    hostWsUrl: "ws://127.0.0.1:8787/miniapp",
    noBackup: false,
  });

  console.log("✅ Bundle 构建完成");
  console.log("   hash:", bundle.meta.scriptHash);
  console.log("   内联长度:", bundle.bundleText.length, "字符");
  console.log("");

  console.log("📦 步骤2: Patch 到小游戏 game.js...\n");

  const patchResult = patchQqGameFile(
    MINIAPP_GAME_JS,
    bundle.bundleText,
    { noBackup: false }
  );

  if (patchResult.replacedExistingBlock) {
    console.log("✅ 已替换原有的 qq-farm 注入块");
  } else {
    console.log("✅ 已追加 qq-farm 注入块到文件末尾");
  }
  console.log("   目标文件:", patchResult.targetPath);
  if (patchResult.backupPath) {
    console.log("   备份文件:", patchResult.backupPath);
  }

  console.log("\n🎉 完成！请重启小游戏让新 bundle 生效。");
}

main().catch((err) => {
  console.error("❌ 失败:", err.message);
  process.exit(1);
});
