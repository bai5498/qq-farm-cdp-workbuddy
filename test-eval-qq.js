/**
 * 测试 qq_ws 模式下 eval 是否真的能在小游戏里执行
 * 用法：node test-eval-qq.js
 */
const WebSocket = require("ws");

const ws = new WebSocket("ws://127.0.0.1:8787/ws");
let seq = 0;

ws.on("open", () => {
  console.log("✅ 已连接");

  // 测试1: 用 op:call, path:eval 执行简单代码
  ws.send(JSON.stringify({
    id: `t-${++seq}`,
    op: "call",
    path: "eval",
    args: ["(function(){ return { test: 1, gameCtlType: typeof gameCtl, windowKeys: Object.keys(window).length }; })()"],
  }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.op === "pong") return;
  console.log("📦 响应:", JSON.stringify(msg, null, 2));
  ws.close();
  process.exit(0);
});

ws.on("error", e => {
  console.error("❌", e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("⏰ 超时");
  process.exit(0);
}, 8000);
