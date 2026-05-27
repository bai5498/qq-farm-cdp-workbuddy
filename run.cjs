#!/usr/bin/env node
/**
 * 单进程同时启动 wmpf（Frida + 调试 + CDP）与 WebSocket 网关，无需子进程 spawn。
 */
"use strict";

const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`
农场 CDP 控制 - 启动入口

用法:
  npm run start            使用 .env 中的配置启动（默认）
  npm run start:qq         QQ 小程序宿主模式（qq_ws）
  npm run start:wx         微信 CDP 模式（cdp）
  npm run start:auto       自动检测模式 + 自动农场
  npm run start:qq:auto    QQ 模式 + 自动农场
  npm run start:wx:auto    微信模式 + 自动农场

  也可以直接传参:
  node run.cjs --qq                  QQ 模式
  node run.cjs --wx                  微信 CDP 模式
  node run.cjs --runtime auto        自动检测
  node run.cjs --auto-farm           启用自动农场
  node run.cjs --gateway-port 8787   指定网关端口
  node run.cjs --cdp-ws ws://...     指定 CDP 地址

运行时目标:
  --qq          QQ 小程序宿主 WebSocket（qq_ws）
  --wx          微信小程序 CDP 直连（cdp）
  --runtime X   手动指定: qq | wx | cdp | auto

其他选项:
  --auto-farm              启用自动农场（收获/播种）
  --gateway-host HOST      网关监听地址（默认 127.0.0.1）
  --gateway-port PORT      网关端口（默认 .env 中配置）
  --cdp-ws URL             CDP WebSocket 地址
  --qq-host-ws-url URL     QQ 宿主 WebSocket 地址
  --qq-appid APPID         QQ 小程序 appid
  -h, --help               显示此帮助信息
`.trim());
  process.exit(0);
}

require("./load-env.cjs").loadEnvFiles(__dirname);
require("./apply-cli-overrides.cjs").applyCliOverrides(argv);

const { getConfig } = require("./src/config");
const config = getConfig();

const RUNTIME_LABELS = {
  qq_ws: "QQ 小程序宿主（qq_ws）",
  cdp: "微信 CDP 直连（cdp）",
  auto: "自动检测（auto）",
};

console.log("─".repeat(50));
console.log(`[启动] 运行时目标: ${RUNTIME_LABELS[config.runtimeTarget] || config.runtimeTarget}`);
console.log(`[启动] 网关地址: ${config.gatewayHost}:${config.gatewayPort}`);
if (config.runtimeTarget !== "qq_ws") {
  console.log(`[启动] CDP 地址: ${config.cdpWsUrl}`);
}
if (config.runtimeTarget !== "cdp") {
  console.log(`[启动] QQ WS 路径: ${config.qqWsPath}`);
}
console.log("─".repeat(50));

if (config.runtimeTarget !== "qq_ws") {
  try {
    require("./wmpf/src/index.js");
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.warn(`[启动] wmpf 模块加载失败，降级到纯 CDP 模式: ${err.message}`);
  }
}

try {
  require("./src/index.js");
} catch (e) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(`[启动] 网关启动失败: ${err.message}`);
  if (err.message.includes("EADDRINUSE")) {
    console.error(`[启动] 端口 ${config.gatewayPort} 已被占用，请更换端口（--gateway-port PORT）或关闭占用进程`);
  }
  if (err.stack) console.error(err.stack);
  process.exit(1);
}
