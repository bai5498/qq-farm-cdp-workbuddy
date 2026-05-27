"use strict";
/**
 * watch-and-patch.js — 监控 QQ 小程序目录，发现新版本 game.js 自动打补丁
 *
 * 用法:
 *   node watch-and-patch.js              # 默认 daemon 模式，持续监控
 *   node watch-and-patch.js --once       # 只检测一次就退出
 *   node watch-and-patch.js --daemon     # 显式指定常驻监控
 *
 * 所有路径和端口均从 src/config.js 读取，不再硬编码。
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { getConfig } = require("./src/config");
const { findLatestQqMiniappByAppId, getDefaultQqMiniappSrcRoot } = require("./src/qq-miniapp-discovery");
const { buildQqBundle, patchQqGameFile, MARKER_START } = require("./src/qq-bundle");

// ── CLI 参数解析 ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const modeOnce = args.includes("--once");
const modeDaemon = args.includes("--daemon") || !modeOnce;

// ── 配置 ─────────────────────────────────────────────────────────────────────
const config = getConfig();
const MARKER = "QQ_FARM_AUTOMATION START";

/**
 * 解析监控根目录：优先用 config.qqMiniappSrcRoot，其次自动发现默认路径
 */
function resolveWatchRoot() {
  if (config.qqMiniappSrcRoot) {
    return path.resolve(config.qqMiniappSrcRoot);
  }
  return getDefaultQqMiniappSrcRoot();
}

const watchRoot = resolveWatchRoot();

if (!fs.existsSync(watchRoot)) {
  console.error(`[错误] 监控目录不存在: ${watchRoot}`);
  console.error("请设置 FARM_QQ_MINIAPP_SRC_ROOT 环境变量或确认 QQ 已安装。");
  process.exit(1);
}

console.log("[监控] 目录:", watchRoot);
if (config.qqAppId) {
  console.log("[配置] appId:", config.qqAppId);
}
console.log("[配置] gatewayPort:", config.gatewayPort);
console.log("[模式]", modeOnce ? "--once (仅检测一次)" : "--daemon (常驻监控)");
console.log();

// ── 已打补丁状态缓存 ─────────────────────────────────────────────────────────
// key: game.js 的绝对路径, value: 文件的 mtimeMs (用于检测文件是否被更新覆盖)
const patchedState = new Map();

/**
 * 快速判断文件是否已打补丁（优先查缓存，仅缓存 miss 或 mtime 变化时读文件）
 */
function isAlreadyPatched(gameJsPath) {
  try {
    const stat = fs.statSync(gameJsPath);
    const mtimeMs = stat.mtimeMs;
    const cached = patchedState.get(gameJsPath);
    if (cached !== undefined && cached === mtimeMs) {
      return true; // 缓存命中且 mtime 未变 → 已打补丁
    }
    // 缓存 miss 或 mtime 变了 → 需要读文件确认
    const content = fs.readFileSync(gameJsPath, "utf8");
    const hasMarker = content.includes(MARKER);
    if (hasMarker) {
      patchedState.set(gameJsPath, mtimeMs);
    } else {
      patchedState.delete(gameJsPath);
    }
    return hasMarker;
  } catch (_) {
    return false;
  }
}

// ── 自动发现目标目录 ─────────────────────────────────────────────────────────
/**
 * 根据 appId 自动发现最新的 miniapp 目录；无 appId 时返回 null
 */
function discoverTargetDir() {
  if (!config.qqAppId) return null;
  try {
    const result = findLatestQqMiniappByAppId({
      appId: config.qqAppId,
      srcRoot: config.qqMiniappSrcRoot || undefined,
    });
    return result.selected;
  } catch (e) {
    console.error(`[发现] 自动发现失败: ${e.message}`);
    return null;
  }
}

// ── 通知 gateway ─────────────────────────────────────────────────────────────
/**
 * 打完补丁后通知 gateway 重启自动化
 */
function notifyGateway() {
  const url = `http://127.0.0.1:${config.gatewayPort}/api/auto-farm`;
  const req = http.request(url, { method: "POST", timeout: 3000 }, (res) => {
    res.resume(); // 消费响应体
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`[gateway] 已通知重启 (${res.statusCode})`);
    } else {
      console.log(`[gateway] 通知返回状态 ${res.statusCode}`);
    }
  });
  req.on("error", (e) => {
    // gateway 未启动是常见情况，不打 error
    console.log(`[gateway] 通知失败: ${e.message}`);
  });
  req.on("timeout", () => {
    req.destroy();
    console.log("[gateway] 通知超时");
  });
  req.end();
}

// ── 打补丁核心逻辑 ───────────────────────────────────────────────────────────
/**
 * 对指定 game.js 打补丁
 * @returns {boolean} 是否成功打了新补丁
 */
function tryPatchDir(dirName, gameJsPath) {
  if (isAlreadyPatched(gameJsPath)) {
    return false;
  }

  try {
    // 文件太小说还没写完或不是目标文件
    const stat = fs.statSync(gameJsPath);
    if (stat.size < 100000) {
      return false;
    }

    const built = buildQqBundle({ config, projectRoot: path.resolve(__dirname) });
    const result = patchQqGameFile(gameJsPath, built.bundleText, { noBackup: false });

    // 更新缓存
    const newStat = fs.statSync(gameJsPath);
    patchedState.set(gameJsPath, newStat.mtimeMs);

    console.log(`[补丁] 成功: ${gameJsPath}`);
    console.log(`       hash: ${built.meta.scriptHash}`);
    console.log(`       备份: ${result.backupPath}`);
    return true;
  } catch (e) {
    console.error(`[错误] ${dirName}:`, e.message);
    return false;
  }
}

// ── 扫描并处理 ────────────────────────────────────────────────────────────────
/**
 * 扫描所有匹配目录，对需要打补丁的文件执行补丁
 * @returns {number} 本次新打补丁的文件数
 */
function scanAndPatch() {
  let patchedCount = 0;

  // 如果有 appId，优先用自动发现
  if (config.qqAppId) {
    const target = discoverTargetDir();
    if (target && target.gameJsPath) {
      if (tryPatchDir(target.versionDirName, target.gameJsPath)) {
        patchedCount++;
      } else {
        console.log(`[跳过] ${target.versionDirName} 已有补丁`);
      }
    }
    return patchedCount;
  }

  // 无 appId 时扫描整个 watchRoot
  let dirs;
  try {
    dirs = fs.readdirSync(watchRoot, { withFileTypes: true });
  } catch (_) {
    return patchedCount;
  }

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const gameJsPath = path.join(watchRoot, entry.name, "game.js");
    if (!fs.existsSync(gameJsPath)) continue;

    if (tryPatchDir(entry.name, gameJsPath)) {
      patchedCount++;
    }
  }

  return patchedCount;
}

// ── 等待文件写入完成 ──────────────────────────────────────────────────────────
/**
 * 等待 game.js 文件写入完成（文件大小稳定后回调）
 */
function waitForFileStable(gameJsPath, callback) {
  let lastSize = -1;
  let stableCount = 0;
  const checkInterval = setInterval(() => {
    try {
      const stat = fs.statSync(gameJsPath);
      if (stat.size === lastSize) {
        stableCount++;
      } else {
        stableCount = 0;
        lastSize = stat.size;
      }
      // 文件大小连续3次不变（3秒）视为写入完成
      if (stableCount >= 3) {
        clearInterval(checkInterval);
        callback();
      }
    } catch (_) {
      // 文件可能还没出现，继续等
    }
  }, 1000);

  // 超时 60 秒
  setTimeout(() => {
    clearInterval(checkInterval);
  }, 60000);
}

// ── 一次性执行 ────────────────────────────────────────────────────────────────
function runOnce() {
  console.log("[once] 开始检测...");

  if (config.qqAppId) {
    const target = discoverTargetDir();
    if (target && target.gameJsPath) {
      if (isAlreadyPatched(target.gameJsPath)) {
        console.log(`[once] ${target.versionDirName} 已有补丁，无需操作`);
        return;
      }
      // 文件可能还没写完，等待稳定
      const stat = fs.statSync(target.gameJsPath);
      if (stat.size < 100000) {
        console.log(`[once] ${target.versionDirName} 文件较小 (${stat.size} bytes)，等待写入完成...`);
        waitForFileStable(target.gameJsPath, () => {
          if (tryPatchDir(target.versionDirName, target.gameJsPath)) {
            notifyGateway();
          }
        });
      } else {
        if (tryPatchDir(target.versionDirName, target.gameJsPath)) {
          notifyGateway();
        }
      }
    }
    return;
  }

  // 无 appId，全量扫描
  const count = scanAndPatch();
  if (count > 0) {
    notifyGateway();
  }
}

// ── 守护进程模式 ──────────────────────────────────────────────────────────────
function runDaemon() {
  // 先做一次初始扫描
  console.log("[daemon] 初始扫描...");
  const initialCount = scanAndPatch();
  if (initialCount > 0) {
    notifyGateway();
  }

  // fs.watch 监控目录变化
  let debounceTimer = null;

  function onWatchEvent(eventType, filename) {
    if (!filename) return;

    // 过滤：只关注目录级别的变化（新目录创建或 game.js 文件变化）
    if (!debounceTimer) {
      console.log(`[watch] 检测到变化: ${eventType} ${filename}`);
    }

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      console.log("[daemon] 变更已稳定，重新扫描...");
      const count = scanAndPatch();
      if (count > 0) {
        notifyGateway();
      }
    }, 1000); // 1 秒 debounce
  }

  let watcher = null;
  try {
    watcher = fs.watch(watchRoot, { recursive: false }, onWatchEvent);
    watcher.on("error", (err) => {
      console.error(`[watch] 监控错误: ${err.message}`);
      // 尝试重新建立监控
      setTimeout(() => {
        console.log("[watch] 尝试重新建立监控...");
        try {
          if (watcher) watcher.close();
        } catch (_) {}
        try {
          watcher = fs.watch(watchRoot, { recursive: false }, onWatchEvent);
          watcher.on("error", (err) => console.error(`[watch] 监控错误: ${err.message}`));
        } catch (e) {
          console.error(`[watch] 重建监控失败: ${e.message}`);
        }
      }, 5000);
    });
  } catch (e) {
    console.error(`[watch] 无法监控目录: ${e.message}`);
    console.error("回退到轮询模式...");

    // 回退到轮询
    const POLL_INTERVAL_MS = 5000;
    console.log(`[poll] 每 ${POLL_INTERVAL_MS / 1000}s 扫描一次`);
    setInterval(() => {
      const count = scanAndPatch();
      if (count > 0) {
        notifyGateway();
      }
    }, POLL_INTERVAL_MS);
    return;
  }

  console.log("[daemon] fs.watch 已就绪，等待文件变化...");
  console.log("按 Ctrl+C 退出\n");

  // 优雅关闭
  function shutdown() {
    console.log("\n[daemon] 正在关闭...");
    clearTimeout(debounceTimer);
    if (watcher) {
      watcher.close();
    }
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
if (modeOnce) {
  runOnce();
} else {
  runDaemon();
}
