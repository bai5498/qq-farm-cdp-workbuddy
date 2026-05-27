const WebSocket = require("ws");
const ws = new WebSocket("ws://127.0.0.1:8787/miniapp");
ws.on("open", () => {
  console.log("ws connected");
  ws.send(JSON.stringify({ id: "p1", op: "hello", data: { type: "client", name: "test" } }));
  setTimeout(() => {
    ws.send(JSON.stringify({ id: "p2", op: "call", path: "gameCtl.getFarmStatus", args: [{}] }));
  }, 500);
});
ws.on("message", d => {
  console.log("msg:", d.toString().slice(0, 200));
  ws.close();
  process.exit(0);
});
ws.on("error", e => { console.log("err:", e.message); process.exit(1); });
setTimeout(() => { console.log("timeout"); process.exit(1); }, 4000);
