// 安全测试脚本 - 只查询，不发送任何事件
const WebSocket = require('ws');

const WS_URL = 'ws://127.0.0.1:8787/ws';

async function main() {
  const ws = new WebSocket(WS_URL);
  let requestId = 0;

  function send(msg) {
    const id = `test-${++requestId}`;
    const payload = { ...msg, id };
    console.log('>>>', JSON.stringify(payload));
    ws.send(JSON.stringify(payload));
    return id;
  }

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('<<<', JSON.stringify(msg));
  });

  ws.on('open', () => {
    console.log('WebSocket 已连接\n');
    console.log('=== 只读测试：查找施肥相关 API ===\n');

    // 1. 获取游戏状态
    send({ op: 'call', path: 'gameCtl.getFarmStatus', args: [{ includeGrids: true }] });

    // 2. 查找 gameCtl 上所有方法
    send({ op: 'eval', code: `Object.keys(window.gameCtl || {}).filter(k => typeof window.gameCtl[k] === 'function').sort()` });

    // 3. 查找包含 fertilizer/fertilize/施肥 关键字的方法
    send({ op: 'eval', code: `
      const methods = Object.keys(window.gameCtl || {});
      methods.filter(k => k.toLowerCase().includes('fertil') || k.includes('施肥') || k.includes('土地'))
    ` });

    // 4. 查找 oopsMessage 上的事件列表
    send({ op: 'eval', code: `
      const msg = window.oopsMessage;
      if (msg && msg._events) {
        Object.keys(msg._events)
      } else if (msg && msg._eventEmitter && msg._eventEmitter._events) {
        Object.keys(msg._eventEmitter._events)
      } else {
        'no _events found'
      }
    ` });

    // 5. 检查是否有 dispatchEvent 方法
    send({ op: 'eval', code: `
      const msg = window.oopsMessage;
      typeof (msg && msg.dispatchEvent)
    ` });

    // 5秒后关闭
    setTimeout(() => {
      console.log('\n=== 测试完成，关闭连接 ===');
      ws.close();
      process.exit(0);
    }, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket 错误:', err.message);
  });
}

main().catch(console.error);
