"use strict";

const crypto = require("node:crypto");

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable message from an error-like value.
 * @param {any} error
 * @returns {string}
 */
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/**
 * Convert a value to a trimmed string; null/undefined become "".
 * @param {any} value
 * @returns {string}
 */
function normalizeText(value) {
  return value == null ? "" : String(value).trim();
}

/**
 * Convert a value to a trimmed string via String(); null/undefined become "".
 * @param {any} value
 * @returns {string}
 */
function trimToString(value) {
  return String(value == null ? "" : value).trim();
}

// ---------------------------------------------------------------------------
// Number helpers
// ---------------------------------------------------------------------------

/**
 * Parse an integer, clamp to [min, max], with a fallback default.
 * @param {any} value
 * @param {number} defaultValue
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function toInt(value, defaultValue, min, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  const fallback = Number.isFinite(n) ? n : defaultValue;
  return Math.min(max, Math.max(min, fallback));
}

/**
 * Alias for toInt – semantically clearer when describing clamping behaviour.
 * @param {any} value
 * @param {number} defaultValue
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, defaultValue, min, max) {
  return toInt(value, defaultValue, min, max);
}

/**
 * Return Math.floor(Number(value)) if it is a finite positive number, else null.
 * @param {any} value
 * @returns {number | null}
 */
function toPositiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/**
 * Coerce a value to boolean with a default.
 * Recognises: true/false, 1/0, "true"/"false", "yes"/"no", "on"/"off".
 * @param {any} value
 * @param {boolean} defaultValue
 * @returns {boolean}
 */
function toBool(value, defaultValue) {
  if (value == null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (!text) return defaultValue;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return defaultValue;
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Return a promise that resolves after `ms` milliseconds (minimum 0).
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/**
 * Alias for sleep – matches the naming used in auto-farm-executor.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return sleep(ms);
}

// ---------------------------------------------------------------------------
// Expression builder
// ---------------------------------------------------------------------------

/**
 * Build an IIFE expression string that traverses a dot-path on globalThis
 * and calls the resulting function with the given args.
 * @param {string} dotPath  e.g. "gameCtl.getFarmStatus"
 * @param {any[]}  args
 * @returns {string}
 */
function wrapCallExpression(dotPath, args) {
  const parts = String(dotPath || "").split(".").filter(Boolean);
  if (parts.length === 0) throw new Error("call.path empty");
  const jsonArgs = JSON.stringify(args ?? []);
  return `(async () => {
    const _path = ${JSON.stringify(parts)};
    let cur = globalThis;
    for (let i = 0; i < _path.length; i++) {
      cur = cur[_path[i]];
      if (cur == null) throw new Error('call path not found at: ' + _path.slice(0, i + 1).join('.'));
    }
    if (typeof cur !== 'function') throw new Error('call path is not a function: ' + _path.join('.'));
    return await cur.apply(null, ${jsonArgs});
  })()`;
}

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-1 hex digest of a string (UTF-8).
 * @param {string} source
 * @returns {string}
 */
function sha1Hex(source) {
  return crypto.createHash("sha1").update(source, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Return a local-date key string "YYYY-MM-DD" for the given date-like value.
 * @param {Date | number | string} [dateLike=Date.now()]
 * @returns {string}
 */
function getLocalDateKey(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike ?? Date.now());
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Resolve the effective log level from the FARM_LOG_LEVEL env var.
 * @returns {number}
 */
function _resolveLogLevel() {
  const raw = (process.env.FARM_LOG_LEVEL || "info").trim().toLowerCase();
  return LOG_LEVELS[raw] != null ? LOG_LEVELS[raw] : LOG_LEVELS.info;
}

let _currentLogLevel = _resolveLogLevel();

/**
 * Create a scoped logger.
 * @param {string} moduleName
 * @returns {{ debug: (...args: any[]) => void, info: (...args: any[]) => void, warn: (...args: any[]) => void, error: (...args: any[]) => void }}
 */
function createLogger(moduleName) {
  const tag = moduleName || "app";

  function _log(level, args) {
    if (LOG_LEVELS[level] < _currentLogLevel) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${tag}]`;
    switch (level) {
      case "error":
        console.error(prefix, ...args);
        break;
      case "warn":
        console.warn(prefix, ...args);
        break;
      case "debug":
      case "info":
      default:
        console.log(prefix, ...args);
        break;
    }
  }

  return {
    debug(...args) { _log("debug", args); },
    info(...args)  { _log("info", args); },
    warn(...args)  { _log("warn", args); },
    error(...args) { _log("error", args); },
  };
}

/** Default logger for ad-hoc use */
const logger = createLogger("utils");

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Error helpers
  toErrorMessage,

  // Text helpers
  normalizeText,
  trimToString,

  // Number helpers
  toInt,
  clampInt,
  toPositiveNumber,
  toBool,

  // Async helpers
  sleep,
  wait,

  // Expression builder
  wrapCallExpression,

  // Crypto helpers
  sha1Hex,

  // Date helpers
  getLocalDateKey,

  // Logger
  createLogger,
  logger,
};
