/**
 * 通过 WebSocket 与 Chrome DevTools Protocol（或 wmpf CDP 代理）通信，
 * 封装本项目需要的 evaluate / 通用命令 / 事件透传。
 */

const { EventEmitter } = require("node:events");
const WebSocket = require("ws");

class CdpSession extends EventEmitter {
  /**
   * @param {{ url: string; timeoutMs?: number; reconnectEnabled?: boolean; maxReconnectAttempts?: number }} opts
   */
  constructor(opts) {
    super();
    this.url = opts.url;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>} */
    this.pending = new Map();

    // 重连相关
    this.reconnectEnabled = opts.reconnectEnabled !== false;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? Infinity;
    /** @type {NodeJS.Timeout | null} */
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._closed = false;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this._closed = false;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const onOpen = () => {
        ws.removeListener("error", onError);
        resolve(undefined);
      };
      const onError = (err) => {
        ws.removeListener("open", onOpen);
        reject(err);
      };

      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    const ws = this.ws;
    if (!ws) throw new Error("CDP WebSocket missing");

    ws.on("message", (data) => {
      let text = data;
      if (Buffer.isBuffer(data)) text = data.toString("utf8");
      else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");

      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        console.warn("[cdp-session] JSON parse failed, raw:", text);
        return;
      }

      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) {
          const err = new Error(msg.error.message || JSON.stringify(msg.error));
          /** @type any */ (err).code = msg.error.code;
          p.reject(err);
        } else {
          p.resolve(msg.result);
        }
        return;
      }

      if (typeof msg.method === "string") {
        this.emit("cdpEvent", msg);
        this.emit(msg.method, msg.params ?? {}, msg);
      }
    });

    ws.on("close", () => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("CDP WebSocket closed"));
      }
      this.pending.clear();

      if (this.reconnectEnabled && !this._closed) {
        this._scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      console.error("[cdp-session] WebSocket error:", err.message || err);
    });

    // 连接成功，重置重连计数
    this._reconnectAttempts = 0;

    await this.send("Runtime.enable", {});
  }

  /**
   * 指数退避重连调度：1s -> 2s -> 4s -> 8s，上限 30s
   */
  _scheduleReconnect() {
    if (this._closed) return;
    if (this._reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        `[cdp-session] Max reconnect attempts (${this.maxReconnectAttempts}) reached, giving up.`
      );
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;

    console.log(
      `[cdp-session] Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})...`
    );

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this._closed) return;

      try {
        // 清理旧 ws
        if (this.ws) {
          try { this.ws.removeAllListeners(); } catch (_) {}
          this.ws = null;
        }

        await this.connect();
        this.emit("reconnected");
        console.log("[cdp-session] Reconnected successfully.");
      } catch (err) {
        console.error("[cdp-session] Reconnect failed:", err.message || err);
        // 继续重连
        this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   */
  send(method, params, timeoutMs = this.timeoutMs) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP not connected"));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  sendCommand(method, params = {}, timeoutMs = this.timeoutMs) {
    return this.send(method, params, timeoutMs);
  }

  /**
   * @param {string} expression 要执行的 JS 表达式（建议自行包 IIFE）
   * @param {{ executionContextId?: number; awaitPromise?: boolean }} extra
   */
  async evaluate(expression, extra = {}) {
    const params = {
      expression,
      returnByValue: true,
      userGesture: true,
      awaitPromise: extra.awaitPromise !== false,
    };
    if (extra.executionContextId != null) {
      params.contextId = extra.executionContextId;
    }

    const result = await this.send("Runtime.evaluate", params);
    const ev = /** @type {any} */ (result);
    if (ev.exceptionDetails) {
      const t = ev.exceptionDetails.exception?.description || ev.exceptionDetails.text || "evaluate failed";
      const err = new Error(String(t));
      /** @type any */ (err).exceptionDetails = ev.exceptionDetails;
      throw err;
    }
    return ev.result?.value;
  }

  /**
   * 供 /api/health 展示，不触发连接。
   */
  getStatusSnapshot() {
    const ws = this.ws;
    const open = !!(ws && ws.readyState === WebSocket.OPEN);
    return {
      mode: "raw_ws",
      wsConnected: open,
      executionContextId: null,
      contextReady: open,
      prepareError: null,
    };
  }

  close() {
    this._closed = true;

    // 取消重连定时器
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
  }
}

module.exports = { CdpSession };
