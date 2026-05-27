"use strict";

const WebSocket = require("ws");

const WS_URL = "ws://127.0.0.1:8787/miniapp";
const CALL_TIMEOUT = 5000;

let ws;
let callSeq = 0;
let pendingCalls = new Map();
let helloReceived = false;

function sendPacket(payload) {
  const reqId = "qqcall-" + (++callSeq);
  const packet = { id: reqId, type: "call", ts: Date.now(), payload };
  console.log(">>> Sent:", JSON.stringify(packet));
  ws.send(JSON.stringify(packet));
  return reqId;
}

function waitForResult(reqId, timeoutMs = CALL_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(reqId);
      reject(new Error("Call timeout: " + reqId));
    }, timeoutMs);
    pendingCalls.set(reqId, { resolve, reject, timer });
  });
}

async function rpc(path, args = []) {
  const reqId = sendPacket({ path, args });
  return await waitForResult(reqId);
}

async function main() {
  return new Promise((resolve) => {
    ws = new WebSocket(WS_URL);
    
    ws.on("open", async () => {
      console.log("✅ WebSocket opened");
      
      // 发送 hello
      console.log("\n--- 发送 hello ---");
      sendPacket({ path: "host.ping", args: [] });
    });
    
    ws.on("message", (data) => {
      const packet = JSON.parse(data.toString());
      console.log("<<< Received:", JSON.stringify(packet));
      
      // 检查 hello 响应
      if (packet.type === "call_result" && packet.payload && packet.payload.hello) {
        helloReceived = true;
        console.log("✅ Hello received:", JSON.stringify(packet.payload.hello, null, 2));
        
        // 开始查询
        setTimeout(() => runQueries(), 500);
      }
      
      // 处理 call_result
      if (packet.type === "call_result" && pendingCalls.has(packet.id)) {
        const { resolve, reject, timer } = pendingCalls.get(packet.id);
        clearTimeout(timer);
        pendingCalls.delete(packet.id);
        resolve(packet.payload);
      }
    });
    
    ws.on("error", (e) => {
      console.error("❌ WebSocket error:", e.message);
    });
    
    ws.on("close", () => {
      console.log("\n🔌 WebSocket closed");
      resolve();
    });
    
    // 10秒后超时
    setTimeout(() => {
      if (!helloReceived) {
        console.log("⏰ Timeout waiting for hello, closing...");
        ws.close();
      }
    }, 10000);
  });
}

async function runQueries() {
  if (!helloReceived) {
    console.log("❌ Not connected yet");
    ws.close();
    return;
  }
  
  try {
    // 1. 检查事件列表
    console.log("\n--- 检查 oopsMessage 事件 ---");
    const events = await rpc("eval", [`JSON.stringify(Object.keys(window.oopsMessage ? window.oopsMessage._events || {} : {}))`]);
    console.log("所有事件:", events);
    
    // 2. 过滤施肥相关
    console.log("\n--- 检查施肥事件 ---");
    const fertEvents = await rpc("eval", [`JSON.stringify(Object.keys(window.oopsMessage ? window.oopsMessage._events || {} : {}).filter(k => /ferti/i.test(k)))`]);
    console.log("施肥事件:", fertEvents);
    
    // 3. 检查 gameCtl
    console.log("\n--- 检查 gameCtl ---");
    const hasFert = await rpc("eval", [`JSON.stringify({fertilizeSingleLand: typeof window.gameCtl?.fertilizeSingleLand, fertilizeLands: typeof window.gameCtl?.fertilizeLands})`]);
    console.log("gameCtl.fertilize:", hasFert);
    
  } catch (e) {
    console.error("❌ Query error:", e.message);
  }
  
  ws.close();
}

main().catch(console.error);
