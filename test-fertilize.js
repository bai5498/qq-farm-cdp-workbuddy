// 测试施肥功能
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
    
    // 如果是 pong，跳过
    if (msg.op === 'pong') return;
    
    // 收到 pong 后，发送 call 请求
    if (msg.id && msg.id.startsWith('ping')) {
      console.log('\n=== 发送施肥测试 ===');
      
      // 先获取游戏状态
      send({ op: 'call', path: 'gameCtl.getFarmStatus', args: [{ includeGrids: true }] });
    }
    
    // 获取状态后，尝试施肥
    if (msg.result && msg.result.grids) {
      console.log('\n=== 游戏状态已获取，检查施肥能力 ===');
      
      // 尝试调用 fertilizeSingleLand
      send({ op: 'call', path: 'gameCtl.fertilizeSingleLand', args: [5, { fertilizerId: 2 }] });
    }
    
    // 施肥结果
    if (msg.result && msg.result.reason === 'no_land_ids') {
      console.log('\n=== 测试不同的事件名 ===');
      
      // 尝试直接 dispatchEvent 来测试施肥
      send({ 
        op: 'eval', 
        code: `
          const msg = window.oopsMessage || window.gameMessage;
          if (msg) {
            const events = ['REQUEST_FERTILIZE', 'REQUEST_USE_FERTILIZER', 'FERTILIZE_REQUEST', 'REQUEST_FERTILIZER'];
            const results = {};
            events.forEach(evt => {
              try {
                if (typeof msg.dispatchEvent === 'function') {
                  msg.dispatchEvent(evt, { land_ids: [5], fertilizer_id: 2 });
                  results[evt] = 'dispatched';
                } else {
                  results[evt] = 'no dispatchEvent';
                }
              } catch(e) {
                results[evt] = 'error: ' + e.message;
              }
            });
            results;
          } else {
            'no message object found'
          }
        `
      });
    }
  });
  
  ws.on('open', () => {
    console.log('WebSocket 已连接\n');
    // 先 ping 确认连接
    send({ op: 'ping' });
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket 错误:', err.message);
  });
}

main().catch(console.error);
