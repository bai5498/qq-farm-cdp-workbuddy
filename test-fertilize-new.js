/**
 * 测试施肥功能 - 新补丁版本（Protobuf 优先路径）
 * 使用 gateway WS 的正确协议格式：{ op: "call", path: "...", args: [...] }
 */
const WebSocket = require("ws");

const WS_URL = "ws://127.0.0.1:8787/ws";
let msgId = 1;

function call(ws, path, args) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), 20000);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === id) {
          clearTimeout(timer);
          ws.removeListener("message", handler);
          if (msg.ok) resolve(msg.result);
          else reject(new Error(msg.error || "call failed"));
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

  // 1. 获取农场状态
  console.log("\n📊 Test 0: getFarmStatus");
  try {
    const state = await call(ws, "gameCtl.getFarmStatus", []);
    if (state && state.lands) {
      console.log(`  Total lands: ${state.lands.length}`);
      const growing = state.lands.filter(l => l.stage === 2 || l.stage === "growing");
      console.log(`  Growing lands: ${growing.length}`);
      if (growing.length > 0) {
        console.log(`  Sample land #${growing[0].landId || growing[0].id}:`, JSON.stringify(growing[0]).substring(0, 200));
      }
    } else {
      console.log("  Result:", JSON.stringify(state).substring(0, 300));
    }
  } catch (e) {
    console.log("  ⚠️", e.message);
  }

  // 2. 测试 fertilizeSingleLand（单地块，不等待结果）
  console.log("\n🧪 Test 1: fertilizeSingleLand(1, 2, {waitForResult:false})");
  try {
    const r1 = await call(ws, "gameCtl.fertilizeSingleLand", [1, 2, { waitForResult: false }]);
    console.log("  ✅ Result:", JSON.stringify(r1, null, 2));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 3. 测试 fertilizeLands（多地块，不等待结果）
  console.log("\n🧪 Test 2: fertilizeLands([1,2,3], 2, {waitForResult:false})");
  try {
    const r2 = await call(ws, "gameCtl.fertilizeLands", [[1, 2, 3], 2, { waitForResult: false }]);
    console.log("  ✅ Result:", JSON.stringify(r2, null, 2));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 4. 测试 fertilizeLands（payload 格式）
  console.log("\n🧪 Test 3: fertilizeLands({land_ids:[1,2],fertilizer_id:2})");
  try {
    const r3 = await call(ws, "gameCtl.fertilizeLands", [{ land_ids: [1, 2], fertilizer_id: 2 }]);
    console.log("  ✅ Result:", JSON.stringify(r3, null, 2));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 5. 测试 fertilizeSingleLand（等待结果模式，5秒超时）
  console.log("\n🧪 Test 4: fertilizeSingleLand(1, 2, {actionTimeoutMs:5000})");
  try {
    const r4 = await call(ws, "gameCtl.fertilizeSingleLand", [1, 2, { actionTimeoutMs: 5000 }]);
    console.log("  ✅ Result:", JSON.stringify(r4, null, 2));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  ws.close();
  console.log("\n✅ All tests done");
}

main().catch(e => console.error("Fatal:", e.message));
