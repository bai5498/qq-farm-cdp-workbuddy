#!/usr/bin/env node

require("../load-env.cjs").loadEnvFiles(require("node:path").join(__dirname, ".."));
require("../apply-cli-overrides.cjs").applyCliOverrides(process.argv.slice(2));

const path = require("node:path");
const { getConfig } = require("./config");
const { createGateway, WS_PATH } = require("./gateway");

const config = getConfig();

let wmpfBridgeOk = false;
if (config.runtimeTarget !== "qq_ws" && config.useWmpfCdpBridge !== false) {
  try {
    const wmpf = require(path.join(__dirname, "..", "wmpf", "src", "index.js"));
    wmpfBridgeOk = !!(wmpf && wmpf.debugMessageEmitter);
  } catch (_) {
    wmpfBridgeOk = false;
  }
}

const { httpServer, close, wss, autoFarmManager } = createGateway(config);

httpServer.listen(config.gatewayPort, config.gatewayHost, () => {
  const host = config.gatewayHost;
  const port = config.gatewayPort;
  console.log(`[gateway] 控制页: http://${host}:${port}/`);
  console.log(`[gateway] WebSocket: ws://${host}:${port}${WS_PATH}`);
  console.log(`[gateway] QQ 宿主 WebSocket: ws://${host}:${port}${config.qqWsPath}`);
  console.log(`[gateway] CDP target: ${config.cdpWsUrl}`);
  console.log(`[gateway] 运行时目标: ${config.runtimeTarget}`);
  if (config.runtimeTarget === "qq_ws") {
    console.log("[gateway] CDP 模式: 已禁用（qq_ws 运行时不启动 wmpf / frida）");
  } else if (wmpfBridgeOk) {
    console.log(
      `[gateway] CDP 模式: wmpf 桥接（含 jscontext_id + 自动探测 gameContext，名称: ${config.gatewayContextName}）`,
    );
  } else {
    console.log("[gateway] CDP 模式: 直连 WebSocket（无 wmpf 桥接时或已设置 FARM_GATEWAY_USE_WMPF_BRIDGE=0）");
  }
  if (config.executionContextId != null) {
    console.log(`[gateway] executionContextId: ${config.executionContextId}`);
  } else {
    console.log(`[gateway] executionContextId: (自动 / 未设置 FARM_EXECUTION_CONTEXT_ID)`);
  }
});

let isShuttingDown = false;

function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log("[shutdown] 开始优雅关闭...");

  // 如果 autoFarmManager 正在运行（busy），等待当前周期完成（最多 10 秒）
  if (autoFarmManager && autoFarmManager.busy) {
    const waitUntil = Date.now() + 10_000;
    const waitBusy = () => {
      if (!autoFarmManager.busy || Date.now() >= waitUntil) {
        if (autoFarmManager.busy) {
          console.log("[shutdown] 等待 autoFarmManager 周期超时，强制继续关闭");
        }
        finishShutdown();
        return;
      }
      setTimeout(waitBusy, 200);
    };
    console.log("[shutdown] 等待 autoFarmManager 当前周期完成...");
    waitBusy();
  } else {
    finishShutdown();
  }
}

function finishShutdown() {
  try {
    close();
  } catch (_) {}

  // 关闭所有 WebSocket 连接
  try {
    if (wss) {
      for (const client of wss.clients) {
        try { client.close(); } catch (_) {}
      }
      wss.close();
    }
  } catch (_) {}

  console.log("[shutdown] 关闭完成");
  process.exit(0);
}

// 15 秒超时保护：无论何种情况，强制退出
setTimeout(() => {
  if (isShuttingDown) {
    console.log("[shutdown] 超时保护触发，强制退出");
    process.exit(1);
  }
}, 15_000);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 全局异常处理
process.on("uncaughtException", (error) => {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[uncaughtException] ${msg}`);
  if (stack) console.error(stack);
  try { shutdown(); } catch (_) {}
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  console.warn(`[unhandledRejection] ${msg}`);
  if (stack) console.warn(stack);
});
