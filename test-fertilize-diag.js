/**
 * 诊断 sendFertilizeViaProtobuf 失败原因
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

  // 1. 检查 getProtobufDefault 是否存在
  console.log("\n🔍 Test: getProtobufDefault availability");
  try {
    const r = await call(ws, "gameCtl.getProtobufDefault", []);
    console.log("  Result:", JSON.stringify(r).substring(0, 300));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 2. 检查 protobufType
  console.log("\n🔍 Test: getProtobufDefault().lookupType('FertilizeRequest')");
  try {
    // 通过 eval 来测试
    const code = `
      (function() {
        try {
          var pb = window.__cdp_host_getProtobufDefault && window.__cdp_host_getProtobufDefault();
          if (!pb) return { error: 'getProtobufDefault returned null/undefined' };
          var keys = Object.keys(pb).slice(0, 20);
          var hasLookup = typeof pb.lookupType === 'function';
          var fertType = null;
          try { fertType = pb.lookupType('FertilizeRequest'); } catch(e) { return { error: 'lookupType failed: ' + e.message, keys, hasLookup }; }
          return { found: !!fertType, name: fertType && fertType.name, fields: fertType && Object.keys(fertType.fields || {}).slice(0, 10), keys, hasLookup };
        } catch(e) { return { error: e.message }; }
      })()
    `;
    const r2 = await call(ws, "eval", [code]);
    // 不对，eval 格式不同
  } catch (e) {
    // 预期会失败
  }

  // 用正确的 eval 格式
  console.log("\n🔍 Test: eval protobuf runtime");
  try {
    const r3 = await call(ws, "probe.protobuf", []);
    console.log("  Result:", JSON.stringify(r3).substring(0, 300));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 3. 用 eval op 检查
  console.log("\n🔍 Test: eval getProtobufDefault");
  try {
    const id = msgId++;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15000);
      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            clearTimeout(timer);
            ws.removeListener("message", handler);
            resolve(msg);
          }
        } catch {}
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id,
        op: "eval",
        code: `
          (function() {
            try {
              var pb = (typeof getProtobufDefault === 'function') ? getProtobufDefault() : null;
              if (!pb) {
                var G = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});
                pb = G.getProtobufDefault ? G.getProtobufDefault() : null;
              }
              if (!pb) return { error: 'getProtobufDefault not found in scope' };
              var keys = Object.keys(pb).slice(0, 30);
              var hasLookup = typeof pb.lookupType === 'function';
              var fertType = null;
              if (hasLookup) {
                try { fertType = pb.lookupType('FertilizeRequest'); } catch(e) { return { error: 'lookupType failed: ' + e.message, keys, hasLookup }; }
              }
              return {
                found: !!fertType,
                name: fertType && fertType.name,
                fields: fertType ? Object.keys(fertType.fields || {}) : [],
                keys: keys,
                hasLookup: hasLookup
              };
            } catch(e) { return { error: e.message }; }
          })()
        `
      }));
    });
    console.log("  Eval result:", JSON.stringify(result.result || result.error).substring(0, 500));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 4. 检查 button.js 中 getProtobufDefault 是如何定义的
  console.log("\n🔍 Test: eval button.js getProtobufDefault source");
  try {
    const id = msgId++;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15000);
      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === id) {
            clearTimeout(timer);
            ws.removeListener("message", handler);
            resolve(msg);
          }
        } catch {}
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id,
        op: "eval",
        code: `
          (function() {
            try {
              var G = (typeof window !== 'undefined') ? window : (typeof global !== 'undefined' ? global : {});
              // 搜索 getProtobufDefault
              var found = [];
              if (typeof G.getProtobufDefault === 'function') found.push('window.getProtobufDefault');
              // 搜索 protobuf 相关的全局对象
              var pbKeys = Object.keys(G).filter(k => k.toLowerCase().includes('protobuf') || k.toLowerCase().includes('proto'));
              // 搜索 oops 框架
              var oopsKeys = G.oops ? Object.keys(G.oops).slice(0, 20) : [];
              // 搜索 gameCtl
              var gcKeys = [];
              if (G.gameCtl) gcKeys = Object.keys(G.gameCtl).slice(0, 30);
              
              return {
                protobufGlobals: pbKeys,
                hasGetProtobufDefault: typeof G.getProtobufDefault === 'function',
                oopsKeys: oopsKeys,
                gameCtlKeys: gcKeys.slice(0, 20),
                gameCtlFertilize: gcKeys.filter(k => k.toLowerCase().includes('fertilize'))
              };
            } catch(e) { return { error: e.message }; }
          })()
        `
      }));
    });
    console.log("  Eval result:", JSON.stringify(result.result || result.error).substring(0, 800));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  // 5. 检查 getProtobufDefault 在 button.js 闭包内的状态
  console.log("\n🔍 Test: eval gameCtl._getProtobufDefault");
  try {
    const r5 = await call(ws, "gameCtl._getProtobufDefault", []);
    console.log("  Result:", JSON.stringify(r5).substring(0, 300));
  } catch (e) {
    console.log("  ❌ Error:", e.message);
  }

  ws.close();
  console.log("\n✅ Done");
}

main().catch(e => console.error("Fatal:", e.message));
