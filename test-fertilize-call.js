// 测试调用 fertilizeSingleLand
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

    // 等待连接
    setTimeout(() => {
      console.log('=== 测试 fertilizeSingleLand ===\n');
      send({ op: 'call', path: 'gameCtl.fertilizeSingleLand', args: [5, { fertilizerId: 2 }] });

      setTimeout(() => {
        console.log('\n=== 测试完成 ===');
        ws.close();
        process.exit(0);
      }, 3000);
    }, 500);
  });

  ws.on('error', (err) => {
    console.error('WebSocket 错误:', err.message);
  });
}

main().catch(console.error);
