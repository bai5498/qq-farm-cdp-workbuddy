// 有问题的测试脚本 - 测试施肥事件触发
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
    console.log('<<<', JSON.stringify(msg).substring(0, 200));
  });

  ws.on('open', () => {
    console.log('WebSocket 已连接\n');
    console.log('=== 发送 eval 测试（可能有问题）===\n');

    // 等待连接建立
    setTimeout(() => {
      // 测试 dispatchEvent 调用
      send({
        op: 'eval',
        code: `
          const msg = window.oopsMessage || window.gameMessage;
          if (msg && typeof msg.dispatchEvent === 'function') {
            const events = ['REQUEST_FERTILIZE', 'FERTILIZE_REQUEST', 'USE_FERTILIZER'];
            events.forEach(evt => {
              try {
                msg.dispatchEvent(evt, { land_ids: [5], fertilizer_id: 2 });
              } catch(e) {}
            });
            'dispatched to 3 events';
          } else {
            'no dispatchEvent found: ' + typeof msg;
          }
        `
      });

      // 5秒后关闭
      setTimeout(() => {
        console.log('\n=== 测试完成 ===');
        ws.close();
        process.exit(0);
      }, 5000);
    }, 1000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket 错误:', err.message);
  });
}

main().catch(console.error);
