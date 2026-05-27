/**
 * 直接通过 gameCtl 调用来诊断 sendFertilizeViaProtobuf 错误
 * 使用 waitForResult=true 来捕获完整的错误链
 */
const WebSocket = require("ws");

const WS_URL = "ws://127.0.0.1:8787/ws";
let msgId = 1;

function call(ws, path, args) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 30000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          if (msg.ok) resolve(msg.result);
          else reject(new Error((msg.error || "unknown") + (msg.detail ? ': ' + JSON.stringify(msg.detail) : "")));
        }
      } catch {}
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, op: "call", path, args: args || [] }));
  });
}

async function main() {
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 10000);
  });
  console.log("✅ WS connected");

  // 1. 获取 gameCtl 方法列表
  console.log("\n📋 gameCtl methods containing 'fertilize':");
  try {
    const r = await call(ws, "gameCtl.getRegisteredMethods", []);
    const methods = r || [];
    const fertMethods = methods.filter(m => m.toLowerCase().includes('fertilize'));
    console.log("  ", fertMethods.join("\n   ") || "(none)");
    console.log(`  Total methods: ${methods.length}`);
    // 也看看有没有 protobuf 相关方法
    const pbMethods = methods.filter(m => m.toLowerCase().includes('protobuf') || m.toLowerCase().includes('proto'));
    console.log("  Protobuf methods:", pbMethods.join(", ") || "(none)");
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 2. 直接调用 fertilizeLands 等待结果，看详细错误
  console.log("\n🧪 fertilizeLands([1], 2, {actionTimeoutMs:3000})");
  try {
    const r = await call(ws, "gameCtl.fertilizeLands", [[1], 2, { actionTimeoutMs: 3000 }]);
    console.log("  Result:", JSON.stringify(r, null, 2));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 3. 测试 sendFertilizeViaProtobuf（如果暴露了的话）
  console.log("\n🧪 gameCtl.sendFertilizeViaProtobuf([1], 2)");
  try {
    const r = await call(ws, "gameCtl.sendFertilizeViaProtobuf", [[1], 2]);
    console.log("  Result:", JSON.stringify(r, null, 2));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 4. 获取 getNetWebSocket
  console.log("\n🧪 gameCtl.getNetWebSocket");
  try {
    const r = await call(ws, "gameCtl.getNetWebSocket", []);
    console.log("  Result:", JSON.stringify(r).substring(0, 300));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 5. 查看 getOopsMessage
  console.log("\n🧪 gameCtl.getOopsMessage");
  try {
    const r = await call(ws, "gameCtl.getOopsMessage", []);
    console.log("  Result:", JSON.stringify(r).substring(0, 300));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  ws.close();
  console.log("\n✅ Done");
}

main().catch(e => console.error("Fatal:", e.message));
