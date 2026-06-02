"use strict";

const {
  normalizeAutoPlantMode,
  normalizeAutoPlantSource,
  normalizeFriendStrategy,
  readAutoPlantSelectedSeedKey,
} = require("./auto-farm-plant-config");

const { sleep: wait, toErrorMessage, normalizeText, toPositiveNumber } = require("./utils");

/**
 * 尝试关闭游戏中的弹框/遮罩层（如升级弹窗）。
 * 静默执行，不抛异常，不影响主流程。
 * @param {Function} callGameCtl - WS 调用函数
 */
async function tryDismissOverlay(callGameCtl) {
  try {
    const result = await callGameCtl("gameCtl.dismissActiveOverlay", [{ silent: true }]);
    if (result && result.ok) {
      console.log("[tryDismissOverlay] 弹框已关闭:", result.action ? result.action.type : "unknown");
    }
  } catch (e) {
    // 静默忽略，不影响主流程
  }
}

function summarizeFarmStatus(status) {
  if (!status || typeof status !== "object") return null;
  return {
    farmType: status.farmType ?? null,
    totalGrids: status.totalGrids ?? null,
    stageCounts: status.stageCounts ?? null,
    workCounts: status.workCounts ?? null,
  };
}

function getWorkCount(status, key) {
  if (!status || !status.workCounts || typeof status.workCounts !== "object") return 0;
  return Number(status.workCounts[key]) || 0;
}

function withSilent(opts, extra) {
  const base = opts && typeof opts === "object" ? { ...opts } : {};
  return { ...base, ...(extra && typeof extra === "object" ? extra : {}), silent: true };
}

async function autoReconnectIfNeeded(session, callGameCtl, opts) {
  try {
    return await callGameCtl(session, "gameCtl.autoReconnectIfNeeded", [withSilent(opts)]);
  } catch (error) {
    return {
      ok: false,
      handled: false,
      error: toErrorMessage(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Recovery error classification
// ---------------------------------------------------------------------------

/**
 * Determine whether an error is recoverable (e.g. disconnection, timeout, not connected).
 * Non-recoverable errors (parameter errors, permission errors, etc.) should not be retried.
 */
function isRecoverableError(error) {
  const msg = toErrorMessage(error).toLowerCase();
  if (!msg) return true; // unknown errors default to recoverable
  const nonRecoverablePatterns = [
    "invalid parameter",
    "invalid argument",
    "parameter error",
    "argument error",
    "permission denied",
    "access denied",
    "forbidden",
    "not found",
    "already",
    "insufficient",
    "not enough",
    "limit reached",
    "seed_not_found",
    "no_empty",
  ];
  for (let i = 0; i < nonRecoverablePatterns.length; i += 1) {
    if (msg.includes(nonRecoverablePatterns[i])) return false;
  }
  return true;
}

async function callGameCtlWithRecovery(session, callGameCtl, pathName, args, opts) {
  const callOpts = opts && typeof opts === "object" ? opts : {};
  const maxRecoveryRetries = callOpts.maxRecoveryRetries != null ? Number(callOpts.maxRecoveryRetries) : 3;
  const recoveryBaseDelayMs = callOpts.recoveryBaseDelayMs != null ? Number(callOpts.recoveryBaseDelayMs) : 1000;
  const reconnectOpts = {
    waitAfter: callOpts.reconnectWaitAfter,
    waitForRecovered: callOpts.reconnectWaitForRecovered,
    recoverTimeoutMs: callOpts.reconnectRecoverTimeoutMs,
    recoverPollMs: callOpts.reconnectRecoverPollMs,
  };

  await autoReconnectIfNeeded(session, callGameCtl, reconnectOpts);

  let lastError = null;
  for (let attempt = 0; attempt <= maxRecoveryRetries; attempt += 1) {
    try {
      return await callGameCtl(session, pathName, args);
    } catch (error) {
      lastError = error;

      // If not recoverable, throw immediately
      if (!isRecoverableError(error)) {
        throw error;
      }

      // No more retries left
      if (attempt >= maxRecoveryRetries) {
        break;
      }

      // Exponential backoff delay: recoveryBaseDelayMs * 2^attempt
      const delayMs = Math.min(recoveryBaseDelayMs * Math.pow(2, attempt), 30000);
      console.debug(
        `[callGameCtlWithRecovery] attempt ${attempt + 1}/${maxRecoveryRetries} failed for ${pathName},` +
        ` retrying in ${delayMs}ms: ${toErrorMessage(error)}`
      );
      await wait(delayMs);

      // Try to reconnect before next attempt
      const recover = await autoReconnectIfNeeded(session, callGameCtl, reconnectOpts);
      if (recover && recover.handled && callOpts.retryOnReconnect !== false) {
        // Reconnection handled, continue to next iteration which will retry the call
      }
    }
  }

  throw lastError;
}

function normalizeMatchText(value) {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function getPriorityId(item) {
  return (
    toPositiveNumber(item && item.seedId)
    || toPositiveNumber(item && item.itemId)
    || toPositiveNumber(item && item.goodsId)
    || 0
  );
}

function makeSeedKey(source, item) {
  if (source === "shop") {
    return `${source}:${toPositiveNumber(item && item.goodsId) || toPositiveNumber(item && item.itemId) || toPositiveNumber(item && item.seedId) || 0}`;
  }
  return `${source}:${toPositiveNumber(item && item.itemId) || toPositiveNumber(item && item.seedId) || toPositiveNumber(item && item.goodsId) || 0}`;
}

function isPlantableEmptyGrid(grid) {
  return !!(
    grid
    && grid.stageKind === "empty"
    && grid.interactable === true
  );
}

function decorateSeedList(list, source, opts) {
  const availableOnly = !opts || opts.availableOnly !== false;
  return (Array.isArray(list) ? list : [])
    .filter((item) => !!item && !item.isMultiLandPlant)
    .filter((item) => {
      if (source !== "backpack" || !availableOnly) return true;
      return (Number(item.count) || 0) > 0;
    })
    .map((item) => ({
      ...item,
      source,
      key: makeSeedKey(source, item),
    }));
}

function compareSeedMetrics(a, b) {
  const keys = ["level", "layer", "rarity"];
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const diff = (Number(a && a[key]) || 0) - (Number(b && b[key]) || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isBetterSeed(next, current, order) {
  if (!current) return true;
  const metricDiff = compareSeedMetrics(next, current);
  if (metricDiff !== 0) {
    return order === "lowest" ? metricDiff < 0 : metricDiff > 0;
  }

  if (next.source !== current.source) {
    if (next.source === "backpack") return true;
    if (current.source === "backpack") return false;
  }

  return getPriorityId(next) < getPriorityId(current);
}

function pickPrioritySeed(list, order) {
  const items = Array.isArray(list) ? list : [];
  let best = null;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    if (isBetterSeed(item, best, order)) {
      best = item;
    }
  }
  return best;
}

function parseSeedKey(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const match = raw.match(/^(backpack|shop):(.*)$/i);
  if (!match) {
    return {
      source: null,
      raw,
      idOrName: raw,
    };
  }
  return {
    source: String(match[1]).toLowerCase(),
    raw,
    idOrName: normalizeText(match[2]),
  };
}

function matchSeedCandidate(item, target) {
  if (!item) return false;
  const parsed = parseSeedKey(target);
  if (!parsed || !parsed.idOrName) return false;

  if (parsed.source && item.source !== parsed.source) return false;
  if (item.key === parsed.raw) return true;

  const targetId = toPositiveNumber(parsed.idOrName);
  if (targetId != null) {
    if (toPositiveNumber(item.seedId) === targetId) return true;
    if (toPositiveNumber(item.itemId) === targetId) return true;
    if (toPositiveNumber(item.goodsId) === targetId) return true;
  }

  const targetText = normalizeMatchText(parsed.idOrName);
  return !!targetText && normalizeMatchText(item.name) === targetText;
}

function filterCandidatesBySource(list, source) {
  if (source === "auto") return Array.isArray(list) ? list.slice() : [];
  return (Array.isArray(list) ? list : []).filter((item) => item && item.source === source);
}

function collectEmptyLandIds(status) {
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const seen = new Set();
  const out = [];

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = toPositiveNumber(grid && grid.landId);
    if (landId == null || seen.has(landId)) continue;
    if (isPlantableEmptyGrid(grid)) {
      seen.add(landId);
      out.push(landId);
    }
  }

  return out;
}

/**
 * 根据施肥策略筛选可施肥的地块ID列表
 * @param {object} status - getFarmStatus 返回的状态
 * @param {object} opts - { fertilizeStrategy, fertilizeMinLevel }
 *   - "all": 所有非空地块
 *   - "growing": 仅生长中地块（默认）
 *   - "empty": 仅空地
 *   - "low_level": 地块等级 <= fertilizeMinLevel 的非空地块
 * @returns {number[]}
 */
function collectFertilizableLandIds(status, opts) {
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const strategy = (opts && opts.fertilizeStrategy) || "growing";
  const minLevel = (opts && opts.fertilizeMinLevel) || 0;
  const seen = new Set();
  const out = [];

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = toPositiveNumber(grid && grid.landId);
    if (landId == null || seen.has(landId)) continue;

    let match = false;
    if (strategy === "all") {
      // 所有非空地块都施肥
      match = grid.stageKind !== "empty";
    } else if (strategy === "growing") {
      // 仅生长中地块
      match = grid.stageKind === "growing";
    } else if (strategy === "empty") {
      // 仅空地
      match = grid.stageKind === "empty";
    } else if (strategy === "low_level") {
      // 地块等级低于阈值的非空地块
      const gridLevel = toPositiveNumber(grid.level) || 0;
      match = grid.stageKind !== "empty" && gridLevel <= minLevel;
    }

    if (match) {
      seen.add(landId);
      out.push(landId);
    }
  }

  return out;
}

async function getFarmOwnership(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getFarmOwnership", [withSilent(opts)], opts);
}

async function getFarmStatus(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getFarmStatus", [withSilent(opts)], opts);
}

async function getFriendList(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getFriendList", [withSilent(opts, { waitRefresh: true })], opts);
}

async function enterOwnFarm(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.enterOwnFarm", [withSilent(opts)], opts);
}

async function enterFriendFarm(session, callGameCtl, target, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.enterFriendFarm", [target, withSilent(opts)], opts);
}

async function triggerOneClickOperation(session, callGameCtl, typeOrIndex, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.triggerOneClickOperation", [typeOrIndex, withSilent(opts)], opts);
}

async function getSeedList(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getSeedList", [withSilent(opts)], opts);
}

async function getShopSeedList(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getShopSeedList", [withSilent(opts)], opts);
}

async function buyShopGoods(session, callGameCtl, goodsId, num, price) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.buyShopGoods", [goodsId, num, price], null);
}

async function plantSeedsOnLands(session, callGameCtl, seedIdOrItemId, landIds, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.plantSeedsOnLands", [
    seedIdOrItemId,
    Array.isArray(landIds) ? landIds : [landIds],
    withSilent(opts),
  ], opts);
}

async function clickMatureEffect(session, callGameCtl, landId, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.clickMatureEffect", [
    landId,
    withSilent(opts),
  ], opts);
}

async function getHarvestablePlantLandIds(session, callGameCtl, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.getHarvestablePlantLandIds", [
    withSilent(opts),
  ], opts);
}

async function waterSingleLand(session, callGameCtl, landId, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.waterSingleLand", [
    landId,
    withSilent(opts),
  ], opts);
}

async function killBugSingleLand(session, callGameCtl, landId, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.killBugSingleLand", [
    landId,
    withSilent(opts),
  ], opts);
}

async function eraseGrassSingleLand(session, callGameCtl, landId, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.eraseGrassSingleLand", [
    landId,
    withSilent(opts),
  ], opts);
}

async function waterLands(session, callGameCtl, landIds, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.waterLands", [
    Array.isArray(landIds) ? landIds : [landIds],
    withSilent(opts),
  ], opts);
}

async function killBugLands(session, callGameCtl, landIds, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.killBugLands", [
    Array.isArray(landIds) ? landIds : [landIds],
    withSilent(opts),
  ], opts);
}

async function eraseGrassLands(session, callGameCtl, landIds, opts) {
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.eraseGrassLands", [
    Array.isArray(landIds) ? landIds : [landIds],
    withSilent(opts),
  ], opts);
}

// ---------------------------------------------------------------------------
// Fertilize functions (#12)
// ---------------------------------------------------------------------------

async function fertilizeSingleLand(session, callGameCtl, landId, opts) {
  const fertilizerId = opts && opts.fertilizerId != null ? opts.fertilizerId : 2;
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.fertilizeSingleLand", [
    landId,
    fertilizerId,
    withSilent(opts),
  ], opts);
}

async function fertilizeLands(session, callGameCtl, landIds, opts) {
  const fertilizerId = opts && opts.fertilizerId != null ? opts.fertilizerId : 2;
  return await callGameCtlWithRecovery(session, callGameCtl, "gameCtl.fertilizeLands", [
    { land_ids: Array.isArray(landIds) ? landIds : [landIds], fertilizer_id: fertilizerId },
    withSilent(opts, { waitForResult: false }),
  ], opts);
}

function getActionableLandIds(status, key) {
  const landIds = status && status.landIds && status.landIds[key];
  const list = Array.isArray(landIds) ? landIds : [];
  const seen = new Set();
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const landId = toPositiveNumber(list[i]);
    if (landId == null || seen.has(landId)) continue;
    seen.add(landId);
    out.push(landId);
  }
  return out;
}

function getCareActionExecutor(key) {
  if (key === "water") {
    return {
      op: "WATER",
      invoke: waterLands,
    };
  }
  if (key === "eraseGrass") {
    return {
      op: "ERASE_GRASS",
      invoke: eraseGrassLands,
    };
  }
  if (key === "killBug") {
    return {
      op: "KILL_BUG",
      invoke: killBugLands,
    };
  }
  if (key === "fertilize") {
    return {
      op: "FERTILIZE",
      invoke: fertilizeLands,
    };
  }
  throw new Error("unknown care action key: " + key);
}

async function runBatchLandCareTask(session, callGameCtl, spec, statusBefore, opts) {
  const beforeCount = getWorkCount(statusBefore, spec.key);
  const landIds = getActionableLandIds(statusBefore, spec.key);
  const requestTimeoutMs = opts && opts.timeoutMs != null ? opts.timeoutMs : 2500;
  const expTimeoutMs = opts && opts.expTimeoutMs != null ? opts.expTimeoutMs : 1800;
  const expPollMs = opts && opts.expPollMs != null ? opts.expPollMs : 60;
  const expSettleMs = opts && opts.expSettleMs != null ? opts.expSettleMs : 120;
  const detectExp = !(opts && opts.detectExp === false);
  const attempts = [];
  let expLimitReached = false;
  let expLimitResult = null;
  let processedCount = 0;
  let successCount = 0;
  let currentStatus = statusBefore;
  let hasUpdatedStatus = false;
  let needsFinalStatusRefresh = false;

  if (beforeCount > 0 && landIds.length === 0) {
    return {
      ok: false,
      key: spec.key,
      op: spec.op,
      mode: detectExp ? "batch_land_exp_check" : "batch_land",
      reason: "actionable_land_ids_missing",
      beforeCount,
      afterCount: beforeCount,
      batchSize: 0,
      batchCount: 0,
      processedBatchCount: 0,
      plannedCount: 0,
      processedCount: 0,
      successCount: 0,
      attempts,
      nextStatus: statusBefore,
      expLimitReached: false,
      expLimitLandId: null,
      expLimitResult: null,
      requestCount: 0,
    };
  }

  try {
    const result = await spec.invoke(session, callGameCtl, landIds, {
      timeoutMs: requestTimeoutMs,
      expTimeoutMs,
      expPollMs,
      expSettleMs,
      detectExp,
    });
    processedCount = landIds.length;
    if (result && result.afterStatus) {
      currentStatus = result.afterStatus;
      hasUpdatedStatus = true;
      needsFinalStatusRefresh = false;
    } else {
      needsFinalStatusRefresh = true;
    }
    if (result && result.ok) {
      successCount = landIds.length;
    }
    attempts.push({
      ok: !!(result && result.ok),
      landIds: landIds.slice(),
      reason: result && result.reason ? result.reason : null,
      expDelta: result && result.expDelta != null ? result.expDelta : null,
      noExpGain: !!(detectExp && result && result.noExpGain),
      result,
    });
    if (detectExp && result && result.ok && result.noExpGain) {
      expLimitReached = true;
      expLimitResult = result;
    }
  } catch (error) {
    processedCount = landIds.length;
    needsFinalStatusRefresh = true;
    attempts.push({
      ok: false,
      landIds: landIds.slice(),
      error: toErrorMessage(error),
    });
  }

  const statusAfter = hasUpdatedStatus && !needsFinalStatusRefresh && currentStatus && currentStatus.workCounts
    ? currentStatus
    : await getFarmStatus(session, callGameCtl, {
        includeGrids: false,
        includeLandIds: true,
      });
  const afterCount = getWorkCount(statusAfter, spec.key);
  const ok = attempts.every((item) => !!(item && item.ok));

  return {
    ok,
    key: spec.key,
    op: spec.op,
    mode: detectExp ? "batch_land_exp_check" : "batch_land",
    reason: null,
    beforeCount,
    afterCount,
    batchSize: landIds.length,
    batchCount: landIds.length > 0 ? 1 : 0,
    processedBatchCount: attempts.length,
    plannedCount: landIds.length,
    processedCount,
    successCount,
    attempts,
    nextStatus: statusAfter,
    expLimitReached,
    expLimitLandId: null,
    expLimitResult,
    requestCount: attempts.length,
  };
}

function collectMatureLandIds(status) {
  const grids = Array.isArray(status && status.grids) ? status.grids : [];
  const seen = new Set();
  const out = [];

  for (let i = 0; i < grids.length; i += 1) {
    const grid = grids[i];
    const landId = toPositiveNumber(grid && grid.landId);
    if (landId == null || seen.has(landId)) continue;
    if (!grid || grid.stageKind !== "mature") continue;
    if (!(grid.canCollect || grid.canHarvest || grid.canSteal)) continue;
    seen.add(landId);
    out.push(landId);
  }

  return out;
}

function summarizeRuntimeHarvestCandidate(item) {
  return {
    landId: toPositiveNumber(item && item.landId),
    sourceLandId: toPositiveNumber(item && item.sourceLandId),
    isMultiLand: !!(item && item.isMultiLand),
    isSpecialLand: !!(item && item.isSpecialLand),
    landTypeName: item && item.landTypeName ? String(item.landTypeName) : null,
    isMasterLand: !!(item && item.isMasterLand),
    isSlaveLand: !!(item && item.isSlaveLand),
    plantName: item && item.plantName ? String(item.plantName) : null,
    plantId: toPositiveNumber(item && item.plantId),
    canHarvest: !!(item && item.canHarvest),
    canSteal: !!(item && item.canSteal),
    canCollect: !!(item && item.canCollect),
  };
}

function summarizeSpecialCollectActionResult(action) {
  const result = action && action.result ? action.result : null;
  const verify = result && result.verify ? result.verify : null;
  return {
    ok: !!(action && action.ok),
    landId: toPositiveNumber(action && action.landId),
    action: result && result.action ? result.action : null,
    reason: result && result.reason
      ? result.reason
      : verify && verify.reason
        ? verify.reason
        : action && action.error
          ? action.error
          : null,
    fallbackReason: result && result.fallbackReason ? result.fallbackReason : null,
    landTypeName: result && result.landTypeName ? String(result.landTypeName) : null,
    effectType: result && result.effectType ? result.effectType : null,
  };
}

async function collectSupplementalHarvestCandidates(session, callGameCtl, status) {
  const seen = new Set();
  const out = [];
  const gridCandidates = collectMatureLandIds(status);
  let runtimeCandidatePayload = null;

  function addLandIds(list) {
    const arr = Array.isArray(list) ? list : [];
    for (let i = 0; i < arr.length; i += 1) {
      const landId = toPositiveNumber(arr[i]);
      if (landId == null || seen.has(landId)) continue;
      seen.add(landId);
      out.push(landId);
    }
  }

  addLandIds(gridCandidates);

  try {
    runtimeCandidatePayload = await getHarvestablePlantLandIds(session, callGameCtl, {
      farmType: status && status.farmType ? status.farmType : null,
      matureOnly: true,
      multiLandOnly: true,
    });
    addLandIds(runtimeCandidatePayload && runtimeCandidatePayload.landIds);
  } catch (error) {
    console.debug("[collectSupplementalHarvestCandidates] getHarvestablePlantLandIds failed:", toErrorMessage(error));
  }

  return {
    landIds: out,
    gridCandidateLandIds: gridCandidates,
    runtimeCandidateLandIds: Array.isArray(runtimeCandidatePayload && runtimeCandidatePayload.landIds)
      ? runtimeCandidatePayload.landIds.map((item) => toPositiveNumber(item)).filter((item) => item != null)
      : [],
    runtimeCandidates: Array.isArray(runtimeCandidatePayload && runtimeCandidatePayload.list)
      ? runtimeCandidatePayload.list.map(summarizeRuntimeHarvestCandidate)
      : [],
  };
}

async function runSupplementalMatureEffectHarvest(session, callGameCtl, opts) {
  const rawOpts = opts && typeof opts === "object" ? opts : {};
  const actionWaitMs = Math.max(0, Number(rawOpts.actionWaitMs) || 0);
  const statusBefore = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  const farmType = statusBefore && statusBefore.farmType ? statusBefore.farmType : "unknown";
  const candidateInfoBefore = await collectSupplementalHarvestCandidates(session, callGameCtl, statusBefore);
  const candidateLandIds = candidateInfoBefore.landIds;
  const beforeCollectCount = getWorkCount(statusBefore, "collect");

  if (beforeCollectCount > 0 || candidateLandIds.length > 0 || candidateInfoBefore.runtimeCandidates.length > 0) {
    console.log("[auto-farm][special-collect] scan", JSON.stringify({
      farmType,
      beforeCollectCount,
      stageCounts: statusBefore && statusBefore.stageCounts ? statusBefore.stageCounts : null,
      gridCandidateLandIds: candidateInfoBefore.gridCandidateLandIds,
      runtimeCandidateLandIds: candidateInfoBefore.runtimeCandidateLandIds,
      runtimeCandidates: candidateInfoBefore.runtimeCandidates,
      mergedCandidateLandIds: candidateLandIds,
    }));
  }

  if (candidateLandIds.length === 0) {
    return {
      ok: true,
      completed: true,
      farmType,
      action: "skip",
      candidateCount: 0,
      candidateLandIds: [],
      remainingCount: 0,
      remainingLandIds: [],
      before: summarizeFarmStatus(statusBefore),
      after: summarizeFarmStatus(statusBefore),
      actions: [],
    };
  }

  const actions = [];
  for (let i = 0; i < candidateLandIds.length; i += 1) {
    const landId = candidateLandIds[i];
    try {
      const result = await clickMatureEffect(session, callGameCtl, landId, {
        waitForResult: rawOpts.waitForResult !== false,
        timeoutMs: rawOpts.timeoutMs,
        pollMs: rawOpts.pollMs,
        // 自动化补收只处理真正存在成熟特效(星星)的地块；
        // 没有特效时绝不再退回普通单块收获，避免对一键已收地块重复派发请求。
        fallbackDispatch: false,
      });
      actions.push({
        ok: !!(result && result.ok),
        landId,
        result,
      });
    } catch (error) {
      actions.push({
        ok: false,
        landId,
        error: toErrorMessage(error),
      });
      if (rawOpts.stopOnError) break;
    }

    if (actionWaitMs > 0 && i < candidateLandIds.length - 1) {
      await wait(actionWaitMs);
    }
  }

  const statusAfter = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });
  const candidateInfoAfter = await collectSupplementalHarvestCandidates(session, callGameCtl, statusAfter);
  const remainingLandIds = candidateInfoAfter.landIds;
  const completed = remainingLandIds.length === 0;

  console.log("[auto-farm][special-collect] result", JSON.stringify({
    farmType,
    completed,
    candidateLandIds,
    remainingLandIds,
    actions: actions.map(summarizeSpecialCollectActionResult),
    afterCollectCount: getWorkCount(statusAfter, "collect"),
    afterStageCounts: statusAfter && statusAfter.stageCounts ? statusAfter.stageCounts : null,
    afterRuntimeCandidateLandIds: candidateInfoAfter.runtimeCandidateLandIds,
  }));

  return {
    ok: completed,
    completed,
    farmType,
    action: "supplemental_mature_effect_harvest",
    candidateCount: candidateLandIds.length,
    candidateLandIds,
    remainingCount: remainingLandIds.length,
    remainingLandIds,
    before: summarizeFarmStatus(statusBefore),
    after: summarizeFarmStatus(statusAfter),
    actions,
  };
}

async function getAutoPlantSeedCatalog(session, callGameCtl, opts) {
  const includeBackpack = !opts || opts.includeBackpack !== false;
  const includeShop = !opts || opts.includeShop !== false;
  const availableOnly = !opts || opts.availableOnly !== false;
  const catalog = {
    fetchedAt: new Date().toISOString(),
    availableOnly,
    backpack: [],
    shop: [],
    all: [],
    counts: {
      backpack: 0,
      shop: 0,
      all: 0,
    },
    errors: {},
  };

  const tasks = [];

  if (includeBackpack) {
    tasks.push(
      getSeedList(session, callGameCtl, {
        availableOnly,
        sortMode: opts && opts.sortMode != null ? opts.sortMode : 3,
      })
        .then((list) => {
          catalog.backpack = decorateSeedList(list, "backpack", { availableOnly });
        })
        .catch((error) => {
          catalog.errors.backpack = toErrorMessage(error);
        }),
    );
  }

  if (includeShop) {
    tasks.push(
      getShopSeedList(session, callGameCtl, {
        ensureData: !opts || opts.ensureShopData !== false,
        shopId: opts && opts.shopId != null ? opts.shopId : 2,
        sortByLevel: true,
        availableOnly: true,
        closeOverlayAfterEnsure: !!(opts && opts.closeOverlayAfterEnsure),
      })
        .then((list) => {
          catalog.shop = decorateSeedList(list, "shop", { availableOnly: false });
        })
        .catch((error) => {
          catalog.errors.shop = toErrorMessage(error);
        }),
    );
  }

  await Promise.all(tasks);

  catalog.all = catalog.backpack.concat(catalog.shop);
  catalog.counts = {
    backpack: catalog.backpack.length,
    shop: catalog.shop.length,
    all: catalog.all.length,
  };

  return catalog;
}

function resolveSelectedSeedTarget(catalog, source, selectedSeedKey) {
  const parsed = parseSeedKey(selectedSeedKey);
  const strictSource = source === "auto" ? (parsed && parsed.source ? parsed.source : "auto") : source;
  const candidates = filterCandidatesBySource(catalog && catalog.all, strictSource);
  const matched = candidates.find((item) => matchSeedCandidate(item, selectedSeedKey)) || null;

  if (matched) {
    return {
      candidate: matched,
      reason: null,
    };
  }

  if (strictSource === "backpack") {
    return { candidate: null, reason: "selected_seed_not_found_in_backpack" };
  }
  if (strictSource === "shop") {
    return { candidate: null, reason: "selected_seed_not_found_in_shop" };
  }
  return { candidate: null, reason: "selected_seed_not_found" };
}

function resolvePrioritySeedTarget(catalog, source, mode) {
  const candidates = filterCandidatesBySource(catalog && catalog.all, source);
  const order = mode === "lowest" ? "lowest" : "highest";
  const candidate = pickPrioritySeed(candidates, order);
  if (candidate) {
    return { candidate, reason: null };
  }
  if (source === "backpack") return { candidate: null, reason: "no_seeds_in_backpack" };
  if (source === "shop") return { candidate: null, reason: "no_seeds_in_shop" };
  return { candidate: null, reason: "no_seed_available" };
}

// ---------------------------------------------------------------------------
// Special collect helper (#20) - extracted to avoid duplication
// ---------------------------------------------------------------------------

async function tryRunSpecialCollect(session, callGameCtl, opts) {
  const includeSpecialCollect = !opts || opts.includeSpecialCollect !== false;
  if (!includeSpecialCollect) return null;

  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  const stopOnError = !!(opts && opts.stopOnError);

  try {
    const specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
      actionWaitMs,
      timeoutMs: opts && opts.timeoutMs,
      pollMs: opts && opts.pollMs,
      stopOnError,
    });
    return specialCollect;
  } catch (error) {
    return {
      ok: false,
      error: toErrorMessage(error),
    };
  }
}

async function runCurrentFarmOneClickTasks(session, callGameCtl, opts) {
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  const useBatchCareExpCheck = !!(opts && opts.stopCareWhenNoExp);
  const statusBefore = await getFarmStatus(session, callGameCtl, {
    includeGrids: false,
    includeLandIds: useBatchCareExpCheck,
  });
  const farmType = statusBefore && statusBefore.farmType ? statusBefore.farmType : "unknown";
  const includeCollect = !opts || opts.includeCollect !== false;
  const includeWater = !opts || opts.includeWater !== false;
  const includeEraseGrass = !opts || opts.includeEraseGrass !== false;
  const includeKillBug = !opts || opts.includeKillBug !== false;
  const includeFertilize = !!(opts && opts.includeFertilize);
  const fertilizerId = opts && opts.fertilizerId != null ? opts.fertilizerId : 2;
  const fertilizeStrategy = (opts && opts.fertilizeStrategy) || "growing";
  const fertilizeMinLevel = opts && opts.fertilizeMinLevel != null ? opts.fertilizeMinLevel : 0;
  const specs = [];

  if (includeCollect) specs.push({ key: "collect", op: "HARVEST" });
  if (farmType === "own") {
    if (includeEraseGrass) specs.push({ key: "eraseGrass", op: "ERASE_GRASS" });
    if (includeKillBug) specs.push({ key: "killBug", op: "KILL_BUG" });
    if (includeWater) specs.push({ key: "water", op: "WATER" });
    // 施肥不走通用 specs，单独处理
  }

  const actions = [];
  let currentStatus = statusBefore;
  let specialCollect = null;
  let careExpLimitReached = false;
  let careExpLimitInfo = null;

  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i];
    const beforeCount = getWorkCount(currentStatus, spec.key);
    if (beforeCount <= 0) {
      if (spec.key === "collect") {
        specialCollect = await tryRunSpecialCollect(session, callGameCtl, opts);
        if (specialCollect && specialCollect.candidateCount > 0) {
          currentStatus = await getFarmStatus(session, callGameCtl, {
            includeGrids: false,
            includeLandIds: useBatchCareExpCheck,
          });
        }
        if (specialCollect && !specialCollect.ok && opts && opts.stopOnError) break;
      }
      continue;
    }

    try {
      if (useBatchCareExpCheck && spec.key !== "collect") {
        const careSpec = {
          key: spec.key,
          ...getCareActionExecutor(spec.key),
        };
        const batchAction = await runBatchLandCareTask(session, callGameCtl, careSpec, currentStatus, opts);
        currentStatus = batchAction.nextStatus || currentStatus;
        // 批量操作后尝试关闭升级弹窗
        await tryDismissOverlay(callGameCtl);
        const { nextStatus, ...actionEntry } = batchAction;
        actions.push(actionEntry);
        if (batchAction.expLimitReached) {
          careExpLimitReached = true;
          careExpLimitInfo = {
            key: spec.key,
            op: careSpec.op,
            landId: batchAction.expLimitLandId,
            result: batchAction.expLimitResult,
          };
          break;
        }
        if (!batchAction.ok && opts && opts.stopOnError) {
          break;
        }
        continue;
      }

      const trigger = await triggerOneClickOperation(session, callGameCtl, spec.op, {
        includeBefore: false,
        includeAfter: false,
      });
      // 收获/浇水/除草/杀虫后尝试关闭升级弹窗
      await tryDismissOverlay(callGameCtl);
      if (actionWaitMs > 0) {
        await wait(actionWaitMs);
      }
      currentStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: false,
        includeLandIds: useBatchCareExpCheck,
      });
      const afterCount = getWorkCount(currentStatus, spec.key);
      actions.push({
        ok: true,
        key: spec.key,
        op: spec.op,
        beforeCount,
        afterCount,
        trigger,
      });

      if (spec.key === "collect") {
        specialCollect = await tryRunSpecialCollect(session, callGameCtl, opts);
        if (specialCollect && specialCollect.candidateCount > 0) {
          currentStatus = await getFarmStatus(session, callGameCtl, {
            includeGrids: false,
            includeLandIds: useBatchCareExpCheck,
          });
        }
        if (specialCollect && !specialCollect.ok && opts && opts.stopOnError) break;
      }
    } catch (error) {
      actions.push({
        ok: false,
        key: spec.key,
        op: spec.op,
        beforeCount,
        error: toErrorMessage(error),
      });

      if (spec.key === "collect" && (!opts || !opts.stopOnError)) {
        specialCollect = await tryRunSpecialCollect(session, callGameCtl, {
          ...opts,
          stopOnError: false,
        });
        if (specialCollect && specialCollect.candidateCount > 0) {
          currentStatus = await getFarmStatus(session, callGameCtl, {
            includeGrids: false,
            includeLandIds: useBatchCareExpCheck,
          });
        }
      }

      if (opts && opts.stopOnError) break;
    }
  }

  // -------------------------------------------------------------------------
  // 施肥：在浇水之后、收获之后单独执行
  // 使用策略筛选地块 + 传入 fertilizerId
  // -------------------------------------------------------------------------
  let fertilizeAction = null;
  if (farmType === "own" && includeFertilize) {
    try {
      // 刷新状态以获取最新 grids 数据
      currentStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: true,
        includeLandIds: false,
      });
      const fertilizableLandIds = collectFertilizableLandIds(currentStatus, {
        fertilizeStrategy,
        fertilizeMinLevel,
      });
      if (fertilizableLandIds.length > 0) {
        const fertResult = await fertilizeLands(session, callGameCtl, fertilizableLandIds, {
          fertilizerId,
          timeoutMs: opts && opts.timeoutMs,
          stopOnError: !!(opts && opts.stopOnError),
        });
        // 施肥后尝试关闭升级弹窗
        await tryDismissOverlay(callGameCtl);
        const afterStatus = await getFarmStatus(session, callGameCtl, {
          includeGrids: false,
          includeLandIds: false,
        });
        currentStatus = afterStatus || currentStatus;
        fertilizeAction = {
          ok: !!(fertResult && fertResult.ok),
          key: "fertilize",
          op: "FERTILIZE",
          beforeCount: fertilizableLandIds.length,
          afterCount: 0, // 施肥后地块数不易计算
          landCount: fertilizableLandIds.length,
          fertilizerId,
          fertilizeStrategy,
          result: fertResult,
        };
        actions.push(fertilizeAction);
      } else {
        fertilizeAction = {
          ok: true,
          key: "fertilize",
          op: "FERTILIZE",
          beforeCount: 0,
          afterCount: 0,
          landCount: 0,
          fertilizerId,
          fertilizeStrategy,
          reason: "no_fertilizable_lands",
        };
        actions.push(fertilizeAction);
      }
    } catch (error) {
      fertilizeAction = {
        ok: false,
        key: "fertilize",
        op: "FERTILIZE",
        beforeCount: 0,
        afterCount: 0,
        fertilizerId,
        fertilizeStrategy,
        error: toErrorMessage(error),
      };
      actions.push(fertilizeAction);
      if (opts && opts.stopOnError) {
        // 不 break，因为这是最后的动作了
      }
    }
  }

  return {
    farmType,
    careMode: useBatchCareExpCheck && farmType === "own" ? "batch_land_exp_check" : "one_click",
    careExpLimitReached,
    careExpLimitInfo,
    before: summarizeFarmStatus(statusBefore),
    after: summarizeFarmStatus(currentStatus),
    actions,
    specialCollect,
    fertilizeStrategy: includeFertilize ? fertilizeStrategy : null,
    fertilizerId: includeFertilize ? fertilizerId : null,
  };
}

async function autoPlant(session, callGameCtl, opts) {
  const rawOpts = opts && typeof opts === "object" ? opts : {};
  const mode = normalizeAutoPlantMode(rawOpts.autoPlantMode ?? rawOpts.mode);
  const source = normalizeAutoPlantSource(rawOpts.autoPlantSource ?? rawOpts.source, rawOpts.autoPlantMode ?? rawOpts.mode);
  const selectedSeedKey = readAutoPlantSelectedSeedKey(rawOpts);

  if (mode === "none") {
    return {
      ok: true,
      mode,
      source,
      action: "skip",
    };
  }

  const status = await getFarmStatus(session, callGameCtl, {
    includeGrids: true,
    includeLandIds: false,
  });

  if (!status || status.farmType !== "own") {
    return {
      ok: false,
      mode,
      source,
      reason: "not_own_farm",
      status: summarizeFarmStatus(status),
    };
  }

  const emptyLandIds = collectEmptyLandIds(status);
  if (emptyLandIds.length === 0) {
    return {
      ok: true,
      mode,
      source,
      action: "no_empty_lands",
      emptyCount: 0,
    };
  }

  if (mode === "selected" && !selectedSeedKey) {
    return {
      ok: false,
      mode,
      source,
      reason: "selected_seed_required",
      emptyCount: emptyLandIds.length,
    };
  }

  const parsedSelected = parseSeedKey(selectedSeedKey);
  const needBackpack = mode !== "selected"
    ? source !== "shop"
    : source !== "shop" || !parsedSelected || parsedSelected.source === "backpack";
  const needShop = mode !== "selected"
    ? source !== "backpack"
    : source !== "backpack" || !parsedSelected || parsedSelected.source === "shop";

  const catalog = await getAutoPlantSeedCatalog(session, callGameCtl, {
    includeBackpack: needBackpack,
    includeShop: needShop,
    availableOnly: true,
    ensureShopData: true,
  });

  const catalogErrors = Object.keys(catalog.errors || {});
  if (catalogErrors.length > 0 && catalog.counts.all <= 0) {
    return {
      ok: false,
      mode,
      source,
      reason: "seed_catalog_error",
      catalog,
      emptyCount: emptyLandIds.length,
    };
  }

  const target = mode === "selected"
    ? resolveSelectedSeedTarget(catalog, source, selectedSeedKey)
    : resolvePrioritySeedTarget(catalog, source, mode);

  if (!target.candidate) {
    return {
      ok: false,
      mode,
      source,
      reason: target.reason,
      selectedSeedKey: selectedSeedKey || null,
      emptyCount: emptyLandIds.length,
      catalogCounts: catalog.counts,
      catalogErrors: catalog.errors,
    };
  }

  const chosen = target.candidate;
  let buyResult = null;

  if (chosen.source === "shop") {
    if (toPositiveNumber(chosen.goodsId) == null) {
      return {
        ok: false,
        mode,
        source,
        reason: "shop_seed_goods_id_missing",
        selectedSeedKey: chosen.key,
        targetSeed: chosen,
        emptyCount: emptyLandIds.length,
      };
    }

    buyResult = await buyShopGoods(
      session,
      callGameCtl,
      chosen.goodsId,
      emptyLandIds.length,
      chosen.price,
    );
    if (!buyResult || !buyResult.ok) {
      return {
        ok: false,
        mode,
        source,
        reason: "buy_failed",
        selectedSeedKey: chosen.key,
        targetSeed: chosen,
        emptyCount: emptyLandIds.length,
        buyResult,
      };
    }

    const buyWaitMs = rawOpts.buyWaitMs == null
      ? Math.max(120, Number(rawOpts.actionWaitMs) || 0)
      : Math.max(0, Number(rawOpts.buyWaitMs) || 0);
    if (buyWaitMs > 0) {
      await wait(buyWaitMs);
    }
  }

  const plantSeedId = chosen.seedId ?? chosen.itemId ?? chosen.goodsId;
  const plantResult = await plantSeedsOnLands(session, callGameCtl, plantSeedId, emptyLandIds, {
    waitForResult: rawOpts.waitForResult !== false,
    timeoutMs: rawOpts.timeoutMs,
    pollMs: rawOpts.pollMs,
    intervalMs: rawOpts.intervalMs,
    stopOnError: !!rawOpts.stopOnError,
  });

  return {
    ok: !!(plantResult && plantResult.ok),
    mode,
    source,
    action: plantResult && plantResult.action ? plantResult.action : "plant_single_batch",
    emptyCount: emptyLandIds.length,
    seedId: plantSeedId,
    seedName: chosen.name || null,
    seedSource: chosen.source,
    selectedSeedKey: chosen.key,
    targetSeed: chosen,
    buyResult,
    plantResult,
    catalogCounts: catalog.counts,
    catalogErrors: catalog.errors,
  };
}

// ---------------------------------------------------------------------------
// Smart replant (#13) - verify and replant empty lands after autoPlant
// ---------------------------------------------------------------------------

async function runSmartReplant(session, callGameCtl, initialPlantResult, opts) {
  const rawOpts = opts && typeof opts === "object" ? opts : {};
  const maxReplantAttempts = 2;
  const replantWaitMs = 2000;
  const replantAttempts = [];

  // If initial plant was fully successful, no replant needed
  if (initialPlantResult && initialPlantResult.ok && initialPlantResult.emptyCount > 0) {
    // Check if all lands were actually planted
    const status = await getFarmStatus(session, callGameCtl, {
      includeGrids: true,
      includeLandIds: false,
    });
    const remainingEmpty = collectEmptyLandIds(status);
    if (remainingEmpty.length === 0) {
      return { needed: false, attempts: [], finalEmptyCount: 0 };
    }
  } else if (!initialPlantResult || !initialPlantResult.ok) {
    // Initial plant failed, check for empty lands
  } else {
    return { needed: false, attempts: [], finalEmptyCount: 0 };
  }

  for (let attempt = 0; attempt < maxReplantAttempts; attempt += 1) {
    await wait(replantWaitMs);

    const status = await getFarmStatus(session, callGameCtl, {
      includeGrids: true,
      includeLandIds: false,
    });
    const emptyLandIds = collectEmptyLandIds(status);

    if (emptyLandIds.length === 0) {
      return { needed: true, attempts: replantAttempts, finalEmptyCount: 0 };
    }

    try {
      const replantResult = await autoPlant(session, callGameCtl, {
        autoPlantMode: rawOpts.autoPlantMode,
        autoPlantSource: rawOpts.autoPlantSource,
        autoFarmPlantSelectedSeedKey: rawOpts.autoPlantSelectedSeedKey,
        actionWaitMs: rawOpts.actionWaitMs,
        buyWaitMs: rawOpts.buyWaitMs,
        timeoutMs: rawOpts.timeoutMs,
        pollMs: rawOpts.pollMs,
        intervalMs: rawOpts.intervalMs,
        stopOnError: !!rawOpts.stopOnError,
      });
      replantAttempts.push({
        attempt: attempt + 1,
        emptyCount: emptyLandIds.length,
        ok: !!(replantResult && replantResult.ok),
        result: replantResult,
      });

      if (replantResult && replantResult.ok && replantResult.action === "no_empty_lands") {
        return { needed: true, attempts: replantAttempts, finalEmptyCount: 0 };
      }
    } catch (error) {
      replantAttempts.push({
        attempt: attempt + 1,
        emptyCount: emptyLandIds.length,
        ok: false,
        error: toErrorMessage(error),
      });
    }
  }

  // Final check
  try {
    const finalStatus = await getFarmStatus(session, callGameCtl, {
      includeGrids: true,
      includeLandIds: false,
    });
    const finalEmptyCount = collectEmptyLandIds(finalStatus).length;
    return { needed: true, attempts: replantAttempts, finalEmptyCount };
  } catch (error) {
    console.debug("[runSmartReplant] final status check failed:", toErrorMessage(error));
    return { needed: true, attempts: replantAttempts, finalEmptyCount: -1 };
  }
}

async function runOwnFarmAutomation(session, callGameCtl, opts) {
  const enterWaitMs = Math.max(0, Number(opts && opts.enterWaitMs) || 0);
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  let ownership = null;
  try {
    ownership = await getFarmOwnership(session, callGameCtl, { allowWeakUi: true });
  } catch (error) {
    console.debug("[runOwnFarmAutomation] getFarmOwnership failed:", toErrorMessage(error));
    ownership = null;
  }

  let enterOwn = null;
  if (!ownership || ownership.farmType !== "own") {
    enterOwn = await enterOwnFarm(session, callGameCtl, {
      waitMs: enterWaitMs,
      includeAfterOwnership: true,
    });
  }

  const tasks = await runCurrentFarmOneClickTasks(session, callGameCtl, {
    includeCollect: !opts || opts.includeCollect !== false,
    includeWater: !opts || opts.includeWater !== false,
    includeEraseGrass: !opts || opts.includeEraseGrass !== false,
    includeKillBug: !opts || opts.includeKillBug !== false,
    includeFertilize: !!(opts && opts.includeFertilize),
    includeSpecialCollect: !opts || opts.includeSpecialCollect !== false,
    stopCareWhenNoExp: !!(opts && opts.stopCareWhenNoExp),
    actionWaitMs: opts && opts.actionWaitMs,
    timeoutMs: opts && opts.timeoutMs,
    pollMs: opts && opts.pollMs,
    expTimeoutMs: opts && opts.expTimeoutMs,
    expPollMs: opts && opts.expPollMs,
    expSettleMs: opts && opts.expSettleMs,
    stopOnError: !!(opts && opts.stopOnError),
  });

  const plantMode = normalizeAutoPlantMode(opts && opts.autoPlantMode);
  let plantResult = null;
  let replantResult = null;
  if (plantMode !== "none") {
    try {
      if (actionWaitMs > 0) {
        await wait(actionWaitMs);
      }

      plantResult = await autoPlant(session, callGameCtl, {
        autoPlantMode: plantMode,
        autoPlantSource: opts && opts.autoPlantSource,
        autoFarmPlantSelectedSeedKey: opts && opts.autoPlantSelectedSeedKey,
        actionWaitMs: opts && opts.actionWaitMs,
        buyWaitMs: opts && opts.buyWaitMs,
        timeoutMs: opts && opts.timeoutMs,
        pollMs: opts && opts.pollMs,
        intervalMs: opts && opts.intervalMs,
        stopOnError: !!(opts && opts.stopOnError),
      });

      // Smart replant (#13): if plant was not fully successful, verify and replant
      if (plantResult && !plantResult.ok) {
        replantResult = await runSmartReplant(session, callGameCtl, plantResult, {
          autoPlantMode: plantMode,
          autoPlantSource: opts && opts.autoPlantSource,
          autoFarmPlantSelectedSeedKey: opts && opts.autoPlantSelectedSeedKey,
          actionWaitMs: opts && opts.actionWaitMs,
          buyWaitMs: opts && opts.buyWaitMs,
          timeoutMs: opts && opts.timeoutMs,
          pollMs: opts && opts.pollMs,
          intervalMs: opts && opts.intervalMs,
          stopOnError: !!(opts && opts.stopOnError),
        });
      }
    } catch (error) {
      plantResult = { ok: false, error: toErrorMessage(error) };
    }
  }

  return {
    ok: true,
    enterOwn,
    tasks,
    plantResult,
    replantResult,
  };
}

function getFriendPendingActionCount(friend, opts) {
  const work = friend && friend.workCounts && typeof friend.workCounts === "object"
    ? friend.workCounts
    : {};
  let total = 0;
  if (!opts || opts.includeCollect !== false) total += Number(work.collect) || 0;
  if (!opts || opts.includeWater !== false) total += Number(work.water) || 0;
  if (!opts || opts.includeEraseGrass !== false) total += Number(work.eraseGrass) || 0;
  if (!opts || opts.includeKillBug !== false) total += Number(work.killBug) || 0;
  return total;
}

// ---------------------------------------------------------------------------
// Friend farm strategy (#14)
// ---------------------------------------------------------------------------

async function runCurrentFriendFarmTasks(session, callGameCtl, statusBefore, opts) {
  const actionWaitMs = Math.max(0, Number(opts && opts.actionWaitMs) || 0);
  const harvestWaitMs = Math.min(actionWaitMs, 280);
  const includeCollect = !opts || opts.includeCollect !== false;
  const includeWater = !opts || opts.includeWater !== false;
  const includeEraseGrass = !opts || opts.includeEraseGrass !== false;
  const includeKillBug = !opts || opts.includeKillBug !== false;
  const includeSpecialCollect = !opts || opts.includeSpecialCollect !== false;
  const detectCareExp = !!(opts && opts.stopCareWhenNoExp);
  const needLandIds = includeWater || includeEraseGrass || includeKillBug;
  const friendStrategy = normalizeFriendStrategy(opts && opts.friendStrategy);
  const actions = [];
  let currentStatus = statusBefore;
  let specialCollect = null;
  let careExpLimitReached = false;
  let careExpLimitInfo = null;

  async function refreshStatus() {
    currentStatus = await getFarmStatus(session, callGameCtl, {
      includeGrids: false,
      includeLandIds: needLandIds,
    });
    return currentStatus;
  }

  async function runSpecialCollect(stopOnError) {
    if (!includeSpecialCollect) return;
    try {
      specialCollect = await runSupplementalMatureEffectHarvest(session, callGameCtl, {
        actionWaitMs: Math.min(actionWaitMs, 180),
        timeoutMs: opts && opts.timeoutMs,
        pollMs: opts && opts.pollMs,
        stopOnError: !!stopOnError,
      });
      if (specialCollect.candidateCount > 0) {
        await refreshStatus();
      }
    } catch (error) {
      specialCollect = {
        ok: false,
        error: toErrorMessage(error),
      };
      if (stopOnError) throw error;
    }
  }

  // help_first strategy: do help actions (water/eraseGrass/killBug) before steal (collect)
  if (friendStrategy === "help_first" || friendStrategy === "help_only") {
    const careSpecs = [];
    if (includeEraseGrass) careSpecs.push({ key: "eraseGrass", ...getCareActionExecutor("eraseGrass") });
    if (includeKillBug) careSpecs.push({ key: "killBug", ...getCareActionExecutor("killBug") });
    if (includeWater) careSpecs.push({ key: "water", ...getCareActionExecutor("water") });

    for (let i = 0; i < careSpecs.length; i += 1) {
      const careSpec = careSpecs[i];
      const beforeCount = getWorkCount(currentStatus, careSpec.key);
      if (beforeCount <= 0) continue;

      const careAction = await runBatchLandCareTask(session, callGameCtl, careSpec, currentStatus, {
        ...opts,
        detectExp: detectCareExp,
      });
      currentStatus = careAction.nextStatus || currentStatus;
      // 好友帮忙操作后尝试关闭升级弹窗
      await tryDismissOverlay(callGameCtl);
      const { nextStatus, ...actionEntry } = careAction;
      actions.push(actionEntry);

      if (detectCareExp && careAction.expLimitReached) {
        careExpLimitReached = true;
        careExpLimitInfo = {
          key: careSpec.key,
          op: careSpec.op,
          landId: careAction.expLimitLandId,
          result: careAction.expLimitResult,
        };
        break;
      }
      if (!careAction.ok && opts && opts.stopOnError) {
        break;
      }
    }

    // If exp limit reached during help, skip steal
    if (careExpLimitReached && friendStrategy === "help_first") {
      // Still try collect since help_first means both, but skip if exp limit
    }
  }

  // Steal (collect) phase - skip for help_only strategy
  const shouldSteal = friendStrategy !== "help_only";

  if (shouldSteal) {
    const collectBefore = getWorkCount(currentStatus, "collect");
    if (includeCollect && collectBefore > 0) {
      try {
        const trigger = await triggerOneClickOperation(session, callGameCtl, "HARVEST", {
          includeBefore: false,
          includeAfter: false,
        });
        // 好友农场收获后尝试关闭升级弹窗
        await tryDismissOverlay(callGameCtl);
        if (harvestWaitMs > 0) {
          await wait(harvestWaitMs);
        }
        await refreshStatus();
        const collectAfter = getWorkCount(currentStatus, "collect");
        actions.push({
          ok: true,
          key: "collect",
          op: "HARVEST",
          beforeCount: collectBefore,
          afterCount: collectAfter,
          trigger,
        });
      } catch (error) {
        actions.push({
          ok: false,
          key: "collect",
          op: "HARVEST",
          beforeCount: collectBefore,
          error: toErrorMessage(error),
        });
        if (opts && opts.stopOnError) {
          return {
            farmType: "friend",
            careMode: detectCareExp ? "batch_land_exp_check" : "batch_land",
            careExpLimitReached,
            careExpLimitInfo,
            before: summarizeFarmStatus(statusBefore),
            after: summarizeFarmStatus(currentStatus),
            actions,
            specialCollect,
          };
        }
      }
      await runSpecialCollect(!!(opts && opts.stopOnError));
    } else if (includeCollect && includeSpecialCollect) {
      await runSpecialCollect(!!(opts && opts.stopOnError));
    }
  }

  // steal_and_help (default) or steal_only: do help actions after steal
  // steal_only skips help actions entirely
  if (friendStrategy === "steal_and_help" || friendStrategy === "steal_only") {
    // steal_only: skip all care actions (already handled by only running collect above)
    if (friendStrategy === "steal_and_help") {
      const careSpecs = [];
      if (includeEraseGrass) careSpecs.push({ key: "eraseGrass", ...getCareActionExecutor("eraseGrass") });
      if (includeKillBug) careSpecs.push({ key: "killBug", ...getCareActionExecutor("killBug") });
      if (includeWater) careSpecs.push({ key: "water", ...getCareActionExecutor("water") });

      for (let i = 0; i < careSpecs.length; i += 1) {
        const careSpec = careSpecs[i];
        const beforeCount = getWorkCount(currentStatus, careSpec.key);
        if (beforeCount <= 0) continue;

        const careAction = await runBatchLandCareTask(session, callGameCtl, careSpec, currentStatus, {
          ...opts,
          detectExp: detectCareExp,
        });
        currentStatus = careAction.nextStatus || currentStatus;
        const { nextStatus, ...actionEntry } = careAction;
        actions.push(actionEntry);

        if (detectCareExp && careAction.expLimitReached) {
          careExpLimitReached = true;
          careExpLimitInfo = {
            key: careSpec.key,
            op: careSpec.op,
            landId: careAction.expLimitLandId,
            result: careAction.expLimitResult,
          };
          break;
        }
        if (!careAction.ok && opts && opts.stopOnError) {
          break;
        }
      }
    }
  }

  return {
    farmType: "friend",
    careMode: detectCareExp ? "batch_land_exp_check" : "batch_land",
    careExpLimitReached,
    careExpLimitInfo,
    before: summarizeFarmStatus(statusBefore),
    after: summarizeFarmStatus(currentStatus),
    actions,
    specialCollect,
  };
}

async function runFriendStealAutomation(session, callGameCtl, opts) {
  const enterWaitMs = Math.max(0, Number(opts && opts.enterWaitMs) || 0);
  const maxFriends = Math.max(0, Number(opts && opts.maxFriends) || 0) || 5;
  const includeSpecialCollect = !opts || opts.includeSpecialCollect !== false;
  const includeCollect = !opts || opts.includeCollect !== false;
  const includeWater = !opts || opts.includeWater !== false;
  const includeEraseGrass = !opts || opts.includeEraseGrass !== false;
  const includeKillBug = !opts || opts.includeKillBug !== false;
  const friendStrategy = normalizeFriendStrategy(opts && opts.friendStrategy);

  // Adjust include flags based on strategy
  const effectiveIncludeCollect = friendStrategy === "help_only" ? false : includeCollect;
  const effectiveIncludeWater = friendStrategy === "steal_only" ? false : includeWater;
  const effectiveIncludeEraseGrass = friendStrategy === "steal_only" ? false : includeEraseGrass;
  const effectiveIncludeKillBug = friendStrategy === "steal_only" ? false : includeKillBug;

  const friendData = await getFriendList(session, callGameCtl, {
    refresh: !opts || opts.refresh !== false,
    sort: true,
    includeSelf: false,
  });
  const friendList = Array.isArray(friendData && friendData.list) ? friendData.list : [];
  const stealableCandidates = friendList.filter((item) => getFriendPendingActionCount(item, {
    includeCollect: true,
    includeWater: false,
    includeEraseGrass: false,
    includeKillBug: false,
  }) > 0).length;
  const candidates = friendList
    .filter((item) => getFriendPendingActionCount(item, {
      includeCollect: effectiveIncludeCollect,
      includeWater: effectiveIncludeWater,
      includeEraseGrass: effectiveIncludeEraseGrass,
      includeKillBug: effectiveIncludeKillBug,
    }) > 0)
    .sort((a, b) => {
      const diff = getFriendPendingActionCount(b, {
        includeCollect: effectiveIncludeCollect,
        includeWater: effectiveIncludeWater,
        includeEraseGrass: effectiveIncludeEraseGrass,
        includeKillBug: effectiveIncludeKillBug,
      }) - getFriendPendingActionCount(a, {
        includeCollect: effectiveIncludeCollect,
        includeWater: effectiveIncludeWater,
        includeEraseGrass: effectiveIncludeEraseGrass,
        includeKillBug: effectiveIncludeKillBug,
      });
      if (diff !== 0) return diff;
      return (Number(a && a.rank) || 0) - (Number(b && b.rank) || 0);
    })
    .slice(0, maxFriends);
  const visits = [];
  let careExpLimitReached = false;
  let careExpLimitInfo = null;

  for (let i = 0; i < candidates.length; i += 1) {
    const friend = candidates[i];
    const allowCare = !careExpLimitReached;
    const visitActionCount = getFriendPendingActionCount(friend, {
      includeCollect: effectiveIncludeCollect,
      includeWater: allowCare && effectiveIncludeWater,
      includeEraseGrass: allowCare && effectiveIncludeEraseGrass,
      includeKillBug: allowCare && effectiveIncludeKillBug,
    });
    if (visitActionCount <= 0) {
      continue;
    }
    try {
      const enter = await enterFriendFarm(session, callGameCtl, friend.gid, {
        waitMs: enterWaitMs,
        includeAfterOwnership: true,
      });
      const beforeStatus = await getFarmStatus(session, callGameCtl, {
        includeGrids: false,
        includeLandIds: (allowCare && effectiveIncludeWater) || (allowCare && effectiveIncludeEraseGrass) || (allowCare && effectiveIncludeKillBug),
      });
      if (beforeStatus.farmType !== "friend") {
        visits.push({
          ok: false,
          friend,
          enter,
          reason: "not_in_friend_farm",
          status: summarizeFarmStatus(beforeStatus),
        });
        continue;
      }

      const tasks = await runCurrentFriendFarmTasks(session, callGameCtl, beforeStatus, {
        includeCollect: effectiveIncludeCollect,
        includeWater: allowCare && effectiveIncludeWater,
        includeEraseGrass: allowCare && effectiveIncludeEraseGrass,
        includeKillBug: allowCare && effectiveIncludeKillBug,
        includeSpecialCollect,
        friendStrategy,
        stopCareWhenNoExp: allowCare && !!(opts && opts.stopCareWhenNoExp),
        actionWaitMs: opts && opts.actionWaitMs,
        timeoutMs: opts && opts.timeoutMs,
        pollMs: opts && opts.pollMs,
        expTimeoutMs: opts && opts.expTimeoutMs,
        expPollMs: opts && opts.expPollMs,
        expSettleMs: opts && opts.expSettleMs,
        stopOnError: !!(opts && opts.stopOnError),
      });
      const actionList = Array.isArray(tasks && tasks.actions) ? tasks.actions : [];
      const failedAction = actionList.find((item) => item && item.ok === false) || null;
      const visitOk = actionList.every((item) => !!(item && item.ok))
        && (!tasks.specialCollect || tasks.specialCollect.ok !== false);
      const visitReason = actionList.length > 0
        ? null
        : tasks.specialCollect && tasks.specialCollect.candidateCount > 0
          ? "special_collect_only"
          : "no_actionable_after_enter";
      visits.push({
        ok: visitOk,
        friend,
        enter,
        error: failedAction
          ? (failedAction.error || failedAction.reason || null)
          : tasks.specialCollect && tasks.specialCollect.ok === false
            ? (tasks.specialCollect.error || "special_collect_failed")
            : null,
        reason: visitReason,
        before: tasks.before,
        after: tasks.after,
        collectBefore: getWorkCount(beforeStatus, "collect"),
        collectAfter: getWorkCount(tasks.after, "collect"),
        tasks,
      });
      if (tasks.careExpLimitReached) {
        careExpLimitReached = true;
        careExpLimitInfo = tasks.careExpLimitInfo;
      }
      if (!visitOk && opts && opts.stopOnError) break;
    } catch (error) {
      visits.push({
        ok: false,
        friend,
        error: toErrorMessage(error),
      });
      if (opts && opts.stopOnError) break;
    }
  }

  let returnHome = null;
  if (!opts || opts.returnHome !== false) {
    try {
      returnHome = await enterOwnFarm(session, callGameCtl, {
        waitMs: enterWaitMs,
        includeAfterOwnership: true,
      });
    } catch (error) {
      returnHome = {
        ok: false,
        error: toErrorMessage(error),
      };
    }
  }

  return {
    ok: true,
    requestedRefresh: !!(friendData && friendData.requestedRefresh),
    refreshed: !!(friendData && friendData.refreshed),
    refreshError: friendData && friendData.refreshError ? friendData.refreshError : null,
    refreshMode: friendData && friendData.refreshMode ? friendData.refreshMode : "none",
    totalCandidates: Number(friendData && friendData.count) || friendList.length,
    actionableCandidates: candidates.length,
    stealableCandidates,
    friendStrategy,
    careExpLimitReached,
    careExpLimitInfo,
    visits,
    returnHome,
  };
}

async function runAutoFarmCycle({ session, callGameCtl, options }) {
  const opts = options && typeof options === "object" ? options : {};
  const startedAt = new Date().toISOString();
  const ownFarmEnabled = opts.ownFarmEnabled !== false;
  const friendStealEnabled = !!opts.friendStealEnabled;
  const payload = {
    ok: true,
    startedAt,
    ownFarmEnabled,
    friendStealEnabled,
    initialOwnership: null,
    ownFarm: null,
    friendSteal: null,
    finalOwnership: null,
  };

  try {
    payload.initialOwnership = await getFarmOwnership(session, callGameCtl, { allowWeakUi: true });
  } catch (error) {
    console.debug("[runAutoFarmCycle] initial getFarmOwnership failed:", toErrorMessage(error));
    payload.initialOwnership = null;
  }

  if (ownFarmEnabled) {
    payload.ownFarm = await runOwnFarmAutomation(session, callGameCtl, {
      includeCollect: opts.includeCollect !== false,
      includeWater: opts.includeWater !== false,
      includeEraseGrass: opts.includeEraseGrass !== false,
      includeKillBug: opts.includeKillBug !== false,
      includeFertilize: !!opts.includeFertilize,
      stopCareWhenNoExp: !!opts.stopCareWhenNoExp,
      autoPlantMode: opts.autoPlantMode || "none",
      autoPlantSource: opts.autoPlantSource || "auto",
      autoPlantSelectedSeedKey: opts.autoPlantSelectedSeedKey || "",
      includeSpecialCollect: opts.includeSpecialCollect !== false,
      useClientAutoPlant: !!opts.useClientAutoPlant,
      enterWaitMs: opts.enterWaitMs,
      actionWaitMs: opts.actionWaitMs,
      buyWaitMs: opts.buyWaitMs,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      expTimeoutMs: opts.expTimeoutMs,
      expPollMs: opts.expPollMs,
      expSettleMs: opts.expSettleMs,
      intervalMs: opts.intervalMs,
      stopOnError: !!opts.stopOnError,
    });
  }

  if (friendStealEnabled) {
    payload.friendSteal = await runFriendStealAutomation(session, callGameCtl, {
      includeCollect: opts.includeCollect !== false,
      includeWater: opts.includeWater !== false,
      includeEraseGrass: opts.includeEraseGrass !== false,
      includeKillBug: opts.includeKillBug !== false,
      friendStrategy: opts.friendStrategy || "steal_and_help",
      stopCareWhenNoExp: !!opts.stopCareWhenNoExp,
      refresh: opts.refreshFriendList !== false,
      maxFriends: opts.maxFriends,
      enterWaitMs: opts.enterWaitMs,
      actionWaitMs: opts.actionWaitMs,
      includeSpecialCollect: opts.includeSpecialCollect !== false,
      timeoutMs: opts.timeoutMs,
      pollMs: opts.pollMs,
      expTimeoutMs: opts.expTimeoutMs,
      expPollMs: opts.expPollMs,
      expSettleMs: opts.expSettleMs,
      returnHome: opts.returnHome !== false,
      stopOnError: !!opts.stopOnError,
    });
  }

  try {
    payload.finalOwnership = await getFarmOwnership(session, callGameCtl, { allowWeakUi: true });
  } catch (error) {
    console.debug("[runAutoFarmCycle] final getFarmOwnership failed:", toErrorMessage(error));
    payload.finalOwnership = null;
  }

  payload.finishedAt = new Date().toISOString();
  return payload;
}

module.exports = {
  getAutoPlantSeedCatalog,
  runAutoFarmCycle,
};
