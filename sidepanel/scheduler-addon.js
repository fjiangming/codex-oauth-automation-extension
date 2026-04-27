/**
 * Scheduler Addon — 定时自启动任务调度器
 *
 * 完全解耦的插件模块，不修改原有项目任何文件。
 * 通过监听 AUTO_RUN_STATUS 消息感知运行状态，
 * 通过发送 AUTO_RUN / STOP_FLOW 消息与 background 交互。
 *
 * 依赖的全局变量（由 sidepanel.js 提前声明）：
 *   - inputRunCount (DOM element)
 *   - inputAutoSkipFailures (DOM element)
 *   - showToast(msg, level, duration)
 */
(function initSchedulerAddon() {
  'use strict';

  // ============================================================
  // Constants
  // ============================================================

  const STORAGE_PREFIX = 'scheduler-addon-';
  const STORAGE_KEYS = {
    intervalMinutes: STORAGE_PREFIX + 'interval-minutes',
    runsPerBatch: STORAGE_PREFIX + 'runs-per-batch',
    autoSkipEmailFailure: STORAGE_PREFIX + 'auto-skip-email-failure',
    expanded: STORAGE_PREFIX + 'expanded',
    state: STORAGE_PREFIX + 'state',
    nextFireAt: STORAGE_PREFIX + 'next-fire-at',
    completedBatches: STORAGE_PREFIX + 'completed-batches',
    originalTotalRuns: STORAGE_PREFIX + 'original-total-runs',
    remainingRunsAfterSkip: STORAGE_PREFIX + 'remaining-runs-after-skip',
    batchSucceeded: STORAGE_PREFIX + 'batch-succeeded',
    batchSkipped: STORAGE_PREFIX + 'batch-skipped',
    totalSucceeded: STORAGE_PREFIX + 'total-succeeded',
    totalSkipped: STORAGE_PREFIX + 'total-skipped',
  };

  const DEFAULT_INTERVAL_MINUTES = 30;
  const DEFAULT_RUNS_PER_BATCH = 5;
  const MIN_INTERVAL_MINUTES = 1;
  const MAX_INTERVAL_MINUTES = 1440;
  const MIN_RUNS_PER_BATCH = 1;
  const MAX_RUNS_PER_BATCH = 999;

  /** 检测到 waiting_email 后延迟多久再发 STOP_FLOW（避免竞态） */
  const WAITING_EMAIL_SKIP_DELAY_MS = 5000;

  // ============================================================
  // State
  // ============================================================

  /** @type {'idle' | 'running' | 'waiting' | 'stopping'} */
  let schedulerState = 'idle';
  let completedBatches = 0;
  let waitingTimerId = null;
  let countdownTimerId = null;
  let nextFireAt = 0;

  /** 当前批次原始 totalRuns，用于计算跳过后的剩余轮次 */
  let originalTotalRuns = 0;
  /** 跳过后需要补跑的剩余轮次 */
  let remainingRunsAfterSkip = 0;

  /** 用于防抖 waiting_email 跳过 */
  let waitingEmailSkipTimerId = null;
  /** 标记是否正在跳过（避免重复停止） */
  let isSkippingCurrentRun = false;

  /** 缓存最近的 AUTO_RUN_STATUS payload */
  let lastAutoRunPayload = null;

  // ---- 批次统计 ----
  /** 当前批次内成功的次数 */
  let batchSucceeded = 0;
  /** 当前批次内跳过/失败的次数 */
  let batchSkipped = 0;
  /** 累计成功次数 */
  let totalSucceeded = 0;
  /** 累计跳过/失败次数 */
  let totalSkipped = 0;

  // ============================================================
  // DOM References (lazy, created in buildUI)
  // ============================================================

  let elCard, elBadge, elChevron, elBody;
  let elIntervalInput, elRunsInput;
  let elAutoSkipToggle;
  let elBtnStart, elBtnStop;
  let elStatus, elStatusText, elCountdown;

  // ============================================================
  // Persistence Helpers
  // ============================================================

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEYS.intervalMinutes, String(getIntervalMinutes()));
      localStorage.setItem(STORAGE_KEYS.runsPerBatch, String(getRunsPerBatch()));
      localStorage.setItem(STORAGE_KEYS.autoSkipEmailFailure, elAutoSkipToggle?.checked ? '1' : '0');
    } catch (_) { /* ignore */ }
  }

  function loadConfig() {
    try {
      const interval = parseInt(localStorage.getItem(STORAGE_KEYS.intervalMinutes), 10);
      const runs = parseInt(localStorage.getItem(STORAGE_KEYS.runsPerBatch), 10);
      const autoSkip = localStorage.getItem(STORAGE_KEYS.autoSkipEmailFailure);
      if (elIntervalInput && Number.isFinite(interval)) elIntervalInput.value = String(interval);
      if (elRunsInput && Number.isFinite(runs)) elRunsInput.value = String(runs);
      if (elAutoSkipToggle && autoSkip !== null) elAutoSkipToggle.checked = autoSkip === '1';
    } catch (_) { /* ignore */ }
  }

  function saveSchedulerState() {
    try {
      localStorage.setItem(STORAGE_KEYS.state, schedulerState);
      localStorage.setItem(STORAGE_KEYS.nextFireAt, String(nextFireAt || 0));
      localStorage.setItem(STORAGE_KEYS.completedBatches, String(completedBatches));
      localStorage.setItem(STORAGE_KEYS.originalTotalRuns, String(originalTotalRuns));
      localStorage.setItem(STORAGE_KEYS.remainingRunsAfterSkip, String(remainingRunsAfterSkip));
      localStorage.setItem(STORAGE_KEYS.batchSucceeded, String(batchSucceeded));
      localStorage.setItem(STORAGE_KEYS.batchSkipped, String(batchSkipped));
      localStorage.setItem(STORAGE_KEYS.totalSucceeded, String(totalSucceeded));
      localStorage.setItem(STORAGE_KEYS.totalSkipped, String(totalSkipped));
    } catch (_) { /* ignore */ }
  }

  function loadSchedulerState() {
    try {
      const state = localStorage.getItem(STORAGE_KEYS.state);
      const fireAt = parseInt(localStorage.getItem(STORAGE_KEYS.nextFireAt), 10);
      const batches = parseInt(localStorage.getItem(STORAGE_KEYS.completedBatches), 10);
      const origRuns = parseInt(localStorage.getItem(STORAGE_KEYS.originalTotalRuns), 10);
      const remaining = parseInt(localStorage.getItem(STORAGE_KEYS.remainingRunsAfterSkip), 10);

      if (state === 'running' || state === 'waiting' || state === 'stopping') {
        schedulerState = state;
      }
      if (Number.isFinite(batches) && batches >= 0) completedBatches = batches;
      if (Number.isFinite(origRuns) && origRuns > 0) originalTotalRuns = origRuns;
      if (Number.isFinite(remaining) && remaining >= 0) remainingRunsAfterSkip = remaining;

      const bs = parseInt(localStorage.getItem(STORAGE_KEYS.batchSucceeded), 10);
      const bk = parseInt(localStorage.getItem(STORAGE_KEYS.batchSkipped), 10);
      const ts = parseInt(localStorage.getItem(STORAGE_KEYS.totalSucceeded), 10);
      const tk = parseInt(localStorage.getItem(STORAGE_KEYS.totalSkipped), 10);
      if (Number.isFinite(bs) && bs >= 0) batchSucceeded = bs;
      if (Number.isFinite(bk) && bk >= 0) batchSkipped = bk;
      if (Number.isFinite(ts) && ts >= 0) totalSucceeded = ts;
      if (Number.isFinite(tk) && tk >= 0) totalSkipped = tk;

      // 恢复等待状态
      if (schedulerState === 'waiting' && Number.isFinite(fireAt) && fireAt > Date.now()) {
        nextFireAt = fireAt;
        startWaitingTimer(fireAt - Date.now());
      } else if (schedulerState === 'waiting') {
        // 等待时间已过，立即开始下一批
        nextFireAt = 0;
        startNextBatch();
      }
      // 如果是 running 状态，说明页面重载但自动运行仍在后台执行，保持 running 状态即可
    } catch (_) { /* ignore */ }
  }

  function clearSchedulerState() {
    try {
      localStorage.removeItem(STORAGE_KEYS.state);
      localStorage.removeItem(STORAGE_KEYS.nextFireAt);
      localStorage.removeItem(STORAGE_KEYS.completedBatches);
      localStorage.removeItem(STORAGE_KEYS.originalTotalRuns);
      localStorage.removeItem(STORAGE_KEYS.remainingRunsAfterSkip);
      localStorage.removeItem(STORAGE_KEYS.batchSucceeded);
      localStorage.removeItem(STORAGE_KEYS.batchSkipped);
      localStorage.removeItem(STORAGE_KEYS.totalSucceeded);
      localStorage.removeItem(STORAGE_KEYS.totalSkipped);
    } catch (_) { /* ignore */ }
  }

  function saveExpanded(expanded) {
    try {
      localStorage.setItem(STORAGE_KEYS.expanded, expanded ? '1' : '0');
    } catch (_) { /* ignore */ }
  }

  function loadExpanded() {
    try {
      return localStorage.getItem(STORAGE_KEYS.expanded) === '1';
    } catch (_) {
      return false;
    }
  }

  // ============================================================
  // Value Helpers
  // ============================================================

  function getIntervalMinutes() {
    const val = parseInt(elIntervalInput?.value, 10);
    if (!Number.isFinite(val) || val < MIN_INTERVAL_MINUTES) return DEFAULT_INTERVAL_MINUTES;
    return Math.min(MAX_INTERVAL_MINUTES, val);
  }

  function getRunsPerBatch() {
    const val = parseInt(elRunsInput?.value, 10);
    if (!Number.isFinite(val) || val < MIN_RUNS_PER_BATCH) return DEFAULT_RUNS_PER_BATCH;
    return Math.min(MAX_RUNS_PER_BATCH, val);
  }

  function isAutoSkipEmailFailure() {
    return Boolean(elAutoSkipToggle?.checked);
  }

  // ============================================================
  // UI Builder
  // ============================================================

  function buildUI() {
    // 找到插入点：在 #log-section 之前插入
    const logSection = document.getElementById('log-section');
    if (!logSection) {
      console.warn('[scheduler-addon] #log-section not found, cannot inject UI.');
      return false;
    }

    const container = document.createElement('section');
    container.className = 'scheduler-addon';
    container.innerHTML = `
      <div class="scheduler-addon-card" id="scheduler-addon-card">
        <div class="scheduler-addon-header" id="scheduler-addon-header">
          <div class="scheduler-addon-header-left">
            <span class="section-label">定时调度</span>
            <span class="scheduler-addon-badge" id="scheduler-addon-badge" data-state="idle">空闲</span>
          </div>
          <svg class="scheduler-addon-chevron" id="scheduler-addon-chevron" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="scheduler-addon-body" id="scheduler-addon-body">
          <div class="scheduler-addon-row">
            <span class="scheduler-addon-label">间隔时间</span>
            <div class="scheduler-addon-controls">
              <input type="number" id="scheduler-addon-interval" class="scheduler-addon-input"
                value="${DEFAULT_INTERVAL_MINUTES}" min="${MIN_INTERVAL_MINUTES}" max="${MAX_INTERVAL_MINUTES}" step="1" />
              <span class="scheduler-addon-unit">分钟</span>
            </div>
          </div>
          <div class="scheduler-addon-row">
            <span class="scheduler-addon-label">每批次数</span>
            <div class="scheduler-addon-controls">
              <input type="number" id="scheduler-addon-runs" class="scheduler-addon-input"
                value="${DEFAULT_RUNS_PER_BATCH}" min="${MIN_RUNS_PER_BATCH}" max="${MAX_RUNS_PER_BATCH}" step="1" />
              <span class="scheduler-addon-unit">次/批</span>
            </div>
          </div>
          <div class="scheduler-addon-row">
            <span class="scheduler-addon-label">失败跳过</span>
            <div class="scheduler-addon-controls">
              <label class="scheduler-addon-toggle">
                <input type="checkbox" id="scheduler-addon-auto-skip" />
                <span class="scheduler-addon-toggle-track">
                  <span class="scheduler-addon-toggle-thumb"></span>
                </span>
                <span>任务终止时自动跳到下一次</span>
              </label>
            </div>
          </div>
          <div class="scheduler-addon-actions">
            <button id="scheduler-addon-btn-start" class="btn btn-primary btn-sm" type="button">启动调度</button>
            <button id="scheduler-addon-btn-stop" class="btn btn-danger btn-sm" type="button" disabled>停止调度</button>
          </div>
          <div class="scheduler-addon-status" id="scheduler-addon-status">
            <div class="scheduler-addon-status-line">
              <span class="scheduler-addon-status-dot is-idle" id="scheduler-addon-status-dot"></span>
              <span id="scheduler-addon-status-text">调度器未启动</span>
            </div>
            <div class="scheduler-addon-status-line" id="scheduler-addon-batch-stats-line" style="display:none;">
              <span id="scheduler-addon-batch-stats" class="scheduler-addon-stats"></span>
            </div>
            <div class="scheduler-addon-status-line" id="scheduler-addon-total-stats-line" style="display:none;">
              <span id="scheduler-addon-total-stats" class="scheduler-addon-stats"></span>
            </div>
            <div class="scheduler-addon-status-line" id="scheduler-addon-countdown-line" style="display:none;">
              <span>下一批启动：</span>
              <span class="scheduler-addon-countdown" id="scheduler-addon-countdown">--:--</span>
            </div>
          </div>
        </div>
      </div>
    `;

    logSection.parentNode.insertBefore(container, logSection);

    // Cache DOM references
    elCard = document.getElementById('scheduler-addon-card');
    elBadge = document.getElementById('scheduler-addon-badge');
    elChevron = document.getElementById('scheduler-addon-chevron');
    elBody = document.getElementById('scheduler-addon-body');
    elIntervalInput = document.getElementById('scheduler-addon-interval');
    elRunsInput = document.getElementById('scheduler-addon-runs');
    elAutoSkipToggle = document.getElementById('scheduler-addon-auto-skip');
    elBtnStart = document.getElementById('scheduler-addon-btn-start');
    elBtnStop = document.getElementById('scheduler-addon-btn-stop');
    elStatus = document.getElementById('scheduler-addon-status');
    elCountdown = document.getElementById('scheduler-addon-countdown');

    return true;
  }

  // ============================================================
  // UI Update
  // ============================================================

  function updateUI() {
    if (!elCard) return;

    const isActive = schedulerState !== 'idle';

    // Badge
    const badgeMap = {
      idle: { text: '空闲', state: 'idle' },
      running: { text: '运行中', state: 'running' },
      waiting: { text: '等待中', state: 'waiting' },
      stopping: { text: '停止中', state: 'stopping' },
    };
    const badge = badgeMap[schedulerState] || badgeMap.idle;
    elBadge.textContent = badge.text;
    elBadge.setAttribute('data-state', badge.state);

    // Buttons
    elBtnStart.disabled = isActive;
    elBtnStop.disabled = !isActive;

    // Inputs
    elIntervalInput.disabled = isActive;
    elRunsInput.disabled = isActive;
    elAutoSkipToggle.disabled = isActive;

    // Status panel
    const statusDot = document.getElementById('scheduler-addon-status-dot');
    const statusText = document.getElementById('scheduler-addon-status-text');
    const countdownLine = document.getElementById('scheduler-addon-countdown-line');

    elStatus.classList.toggle('is-visible', isActive);

    if (statusDot) {
      statusDot.className = 'scheduler-addon-status-dot';
      if (schedulerState === 'running') statusDot.classList.add('is-running');
      else if (schedulerState === 'waiting') statusDot.classList.add('is-waiting');
      else statusDot.classList.add('is-idle');
    }

    if (statusText) {
      const batchProgress = batchSucceeded + batchSkipped;
      const batchTotal = getRunsPerBatch();
      switch (schedulerState) {
        case 'running': {
          let runningText = `第 ${completedBatches + 1} 批运行中`;
          if (batchProgress > 0) {
            runningText += `（${batchProgress}/${batchTotal}`;
            if (batchSkipped > 0) runningText += ` · 跳过 ${batchSkipped}`;
            runningText += '）';
          }
          runningText += '…';
          statusText.textContent = runningText;
          break;
        }
        case 'waiting':
          statusText.textContent = completedBatches === 0
            ? '首次延迟中，等待启动第一批'
            : `已完成 ${completedBatches} 批，等待下一批`;
          break;
        case 'stopping':
          statusText.textContent = '正在停止…';
          break;
        default:
          statusText.textContent = '调度器未启动';
      }
    }

    // Batch stats line
    const batchStatsLine = document.getElementById('scheduler-addon-batch-stats-line');
    const batchStatsEl = document.getElementById('scheduler-addon-batch-stats');
    if (batchStatsLine && batchStatsEl) {
      const showBatchStats = (schedulerState === 'waiting' || schedulerState === 'running') && (batchSucceeded > 0 || batchSkipped > 0);
      batchStatsLine.style.display = showBatchStats ? '' : 'none';
      if (showBatchStats) {
        const label = schedulerState === 'waiting' ? '上批结果' : '本批进度';
        batchStatsEl.textContent = `${label}：✓ ${batchSucceeded}  ✗ ${batchSkipped}  共 ${batchSucceeded + batchSkipped}`;
      }
    }

    // Total stats line
    const totalStatsLine = document.getElementById('scheduler-addon-total-stats-line');
    const totalStatsEl = document.getElementById('scheduler-addon-total-stats');
    if (totalStatsLine && totalStatsEl) {
      const showTotalStats = isActive && (totalSucceeded > 0 || totalSkipped > 0);
      totalStatsLine.style.display = showTotalStats ? '' : 'none';
      if (showTotalStats) {
        totalStatsEl.textContent = `累计：✓ ${totalSucceeded}  ✗ ${totalSkipped}  共 ${totalSucceeded + totalSkipped}`;
      }
    }

    if (countdownLine) {
      countdownLine.style.display = schedulerState === 'waiting' ? '' : 'none';
    }
  }

  function updateCountdownDisplay() {
    if (!elCountdown || schedulerState !== 'waiting' || !nextFireAt) return;

    const remaining = Math.max(0, nextFireAt - Date.now());
    const totalSec = Math.ceil(remaining / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    elCountdown.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ============================================================
  // Core Scheduler Logic
  // ============================================================

  function startScheduler() {
    if (schedulerState !== 'idle') return;

    saveConfig();
    completedBatches = 0;
    remainingRunsAfterSkip = 0;
    originalTotalRuns = 0;
    batchSucceeded = 0;
    batchSkipped = 0;
    totalSucceeded = 0;
    totalSkipped = 0;

    // 检查原有"延迟 xx 分钟"配置
    const delayEnabled = document.getElementById('input-auto-delay-enabled');
    const delayMinutesInput = document.getElementById('input-auto-delay-minutes');
    const delayMinutes = delayEnabled?.checked
      ? parseInt(delayMinutesInput?.value, 10) || 0
      : 0;

    if (delayMinutes > 0) {
      // 首次延迟：进入等待状态
      const delayMs = delayMinutes * 60 * 1000;
      nextFireAt = Date.now() + delayMs;
      schedulerState = 'waiting';
      saveSchedulerState();
      updateUI();
      toast(`首次延迟 ${delayMinutes} 分钟后开始第一批`, 'info');
      startWaitingTimer(delayMs);
    } else {
      // 无延迟，立即启动第一批
      schedulerState = 'running';
      saveSchedulerState();
      updateUI();
      startBatchRun(getRunsPerBatch());
    }
  }

  function stopScheduler() {
    if (schedulerState === 'idle') return;

    const wasRunning = schedulerState === 'running';
    schedulerState = 'stopping';
    updateUI();

    // 清除所有定时器
    if (waitingTimerId) {
      clearTimeout(waitingTimerId);
      waitingTimerId = null;
    }
    if (countdownTimerId) {
      clearInterval(countdownTimerId);
      countdownTimerId = null;
    }
    if (waitingEmailSkipTimerId) {
      clearTimeout(waitingEmailSkipTimerId);
      waitingEmailSkipTimerId = null;
    }

    nextFireAt = 0;
    isSkippingCurrentRun = false;

    // 如果当前正在运行自动任务，发送停止
    if (wasRunning) {
      chrome.runtime.sendMessage({
        type: 'STOP_FLOW',
        source: 'sidepanel',
        payload: {},
      }).catch(() => { });

      // 超时保底：如果 3 秒内没收到 stopped 回调，强制清理
      setTimeout(() => {
        if (schedulerState === 'stopping') {
          finishStopping();
        }
      }, 3000);
    } else {
      // 不在运行中（如等待状态），直接清理
      finishStopping();
    }
  }

  function finishStopping() {
    // 停止前先 toast 出累计统计
    if (totalSucceeded > 0 || totalSkipped > 0) {
      toast(`累计统计：✓ ${totalSucceeded}  ✗ ${totalSkipped}  共 ${totalSucceeded + totalSkipped}`, 'info', 4000);
    }
    schedulerState = 'idle';
    completedBatches = 0;
    remainingRunsAfterSkip = 0;
    originalTotalRuns = 0;
    isSkippingCurrentRun = false;
    batchSucceeded = 0;
    batchSkipped = 0;
    totalSucceeded = 0;
    totalSkipped = 0;
    clearSchedulerState();
    updateUI();
    toast('定时调度已停止', 'info');
  }

  function startNextBatch() {
    if (schedulerState !== 'waiting' && schedulerState !== 'running') return;

    schedulerState = 'running';
    remainingRunsAfterSkip = 0;
    originalTotalRuns = 0;
    batchSucceeded = 0;
    batchSkipped = 0;
    saveSchedulerState();
    updateUI();

    startBatchRun(getRunsPerBatch());
  }

  function startBatchRun(totalRuns) {
    originalTotalRuns = totalRuns;
    remainingRunsAfterSkip = 0;
    isSkippingCurrentRun = false;

    // 设置 sidepanel 的运行次数输入框
    const inputRunCount = document.getElementById('input-run-count');
    if (inputRunCount) {
      inputRunCount.value = String(totalRuns);
    }

    // 确保自动重试始终开启（跟随原有设置）
    const inputAutoSkipFailures = document.getElementById('input-auto-skip-failures');

    saveSchedulerState();

    // 直接发送 AUTO_RUN 消息给 background，绕过 UI 弹窗确认
    chrome.runtime.sendMessage({
      type: 'AUTO_RUN',
      source: 'sidepanel',
      payload: {
        totalRuns: totalRuns,
        autoRunSkipFailures: Boolean(inputAutoSkipFailures?.checked),
        mode: 'restart',
      },
    }).then((response) => {
      if (response?.error) {
        console.error('[scheduler-addon] AUTO_RUN failed:', response.error);
        toast('调度启动失败：' + response.error, 'error');
        schedulerState = 'idle';
        clearSchedulerState();
        updateUI();
      }
    }).catch((err) => {
      console.error('[scheduler-addon] AUTO_RUN error:', err);
      toast('调度启动失败：' + (err.message || '未知错误'), 'error');
      schedulerState = 'idle';
      clearSchedulerState();
      updateUI();
    });
  }

  function startContinuationRun(remainingRuns) {
    if (schedulerState !== 'running' || remainingRuns <= 0) return;

    isSkippingCurrentRun = false;
    remainingRunsAfterSkip = 0;

    const inputRunCount = document.getElementById('input-run-count');
    if (inputRunCount) {
      inputRunCount.value = String(remainingRuns);
    }

    const inputAutoSkipFailures = document.getElementById('input-auto-skip-failures');

    saveSchedulerState();

    // 短暂延迟确保前一次停止已完全清理
    setTimeout(() => {
      if (schedulerState !== 'running') return;

      chrome.runtime.sendMessage({
        type: 'AUTO_RUN',
        source: 'sidepanel',
        payload: {
          totalRuns: remainingRuns,
          autoRunSkipFailures: Boolean(inputAutoSkipFailures?.checked),
          mode: 'restart',
        },
      }).then((response) => {
        if (response?.error) {
          console.error('[scheduler-addon] Continuation AUTO_RUN failed:', response.error);
          // 补跑失败，进入等待下一批
          onBatchComplete();
        }
      }).catch((err) => {
        console.error('[scheduler-addon] Continuation AUTO_RUN error:', err);
        onBatchComplete();
      });
    }, 2000);
  }

  function onBatchComplete() {
    if (schedulerState !== 'running') return;

    completedBatches += 1;
    remainingRunsAfterSkip = 0;
    originalTotalRuns = 0;
    isSkippingCurrentRun = false;

    const intervalMs = getIntervalMinutes() * 60 * 1000;
    nextFireAt = Date.now() + intervalMs;
    schedulerState = 'waiting';
    saveSchedulerState();
    updateUI();

    toast(`第 ${completedBatches} 批已完成，${getIntervalMinutes()} 分钟后开始下一批`, 'info');

    startWaitingTimer(intervalMs);
  }

  function startWaitingTimer(delayMs) {
    if (waitingTimerId) clearTimeout(waitingTimerId);
    if (countdownTimerId) clearInterval(countdownTimerId);

    updateCountdownDisplay();
    countdownTimerId = setInterval(() => {
      updateCountdownDisplay();
    }, 1000);

    waitingTimerId = setTimeout(() => {
      waitingTimerId = null;
      if (countdownTimerId) {
        clearInterval(countdownTimerId);
        countdownTimerId = null;
      }
      nextFireAt = 0;

      if (schedulerState === 'waiting') {
        startNextBatch();
      }
    }, delayMs);
  }

  // ============================================================
  // Auto-Skip on Email Failure
  // ============================================================

  function handleWaitingEmail(payload) {
    if (schedulerState !== 'running') return;
    if (!isAutoSkipEmailFailure()) return;
    if (isSkippingCurrentRun) return;

    const currentRun = payload?.currentRun || 0;
    const totalRuns = payload?.totalRuns || 0;

    console.log(`[scheduler-addon] Detected waiting_email at run ${currentRun}/${totalRuns}, will auto-skip in ${WAITING_EMAIL_SKIP_DELAY_MS}ms`);

    // 延迟执行，避免瞬间触发
    if (waitingEmailSkipTimerId) {
      clearTimeout(waitingEmailSkipTimerId);
    }

    waitingEmailSkipTimerId = setTimeout(() => {
      waitingEmailSkipTimerId = null;
      if (schedulerState !== 'running' || isSkippingCurrentRun) return;

      isSkippingCurrentRun = true;

      const remaining = totalRuns - currentRun;
      remainingRunsAfterSkip = remaining;
      saveSchedulerState();

      toast(`邮箱获取失败，自动跳过当前任务（剩余 ${remaining} 次）`, 'warn');

      // 停止当前运行
      chrome.runtime.sendMessage({
        type: 'STOP_FLOW',
        source: 'sidepanel',
        payload: {},
      }).catch(() => { });

      // 停止后会触发 AUTO_RUN_STATUS stopped，在那里决定是否补跑
    }, WAITING_EMAIL_SKIP_DELAY_MS);
  }

  // ============================================================
  // Message Listener
  // ============================================================

  function onAutoRunStatus(payload) {
    lastAutoRunPayload = payload;

    const phase = payload?.phase;

    // 调度器主动停止中——仅等待 stopped 确认后清理
    if (schedulerState === 'stopping') {
      if (phase === 'stopped' || phase === 'complete') {
        finishStopping();
      }
      return;
    }

    if (schedulerState === 'idle') return;

    // 运行中的各种活跃状态
    if (phase === 'running' || phase === 'retrying' || phase === 'waiting_step') {
      if (schedulerState === 'running') {
        // 取消等待邮箱的跳过计时器（如果从 waiting_email 恢复了）
        if (waitingEmailSkipTimerId) {
          clearTimeout(waitingEmailSkipTimerId);
          waitingEmailSkipTimerId = null;
        }
        isSkippingCurrentRun = false;
        updateUI();
      }
      return;
    }

    // 等待邮箱——暂停态，不会自动变成 stopped，需要主动干预
    if (phase === 'waiting_email') {
      if (schedulerState === 'running' && isAutoSkipEmailFailure()) {
        handleWaitingEmail(payload);
      }
      return;
    }

    // 等待线程间隔——原系统的定时器，不干预
    if (phase === 'waiting_interval' || phase === 'scheduled') {
      return;
    }

    // 运行完成——所有轮次都执行完了
    if (phase === 'complete') {
      if (schedulerState === 'running') {
        // 统计：该子批次的所有轮次都成功完成
        const completedRuns = payload?.totalRuns || 0;
        batchSucceeded += completedRuns;
        totalSucceeded += completedRuns;
        saveSchedulerState();
        onBatchComplete();
      }
      return;
    }

    // 被停止——核心逻辑：根据 auto-skip 决定是继续还是停止调度器
    if (phase === 'stopped') {
      if (schedulerState !== 'running') return;

      const currentRun = payload?.currentRun || 0;
      const totalRuns = payload?.totalRuns || 0;
      const remaining = Math.max(0, totalRuns - currentRun);

      if (isAutoSkipEmailFailure()) {
        // === 失败跳过已开启：任何终止都尝试继续 ===
        isSkippingCurrentRun = false;

        // 统计：当前轮次算作跳过
        batchSkipped += 1;
        totalSkipped += 1;
        saveSchedulerState();

        if (remaining > 0) {
          // 还有剩余轮次，继续执行
          toast(`当前任务终止（第 ${currentRun}/${totalRuns} 次），自动跳过，继续剩余 ${remaining} 次`, 'warn');
          updateUI();
          startContinuationRun(remaining);
        } else {
          // 没有剩余轮次（最后一轮也被终止），视为本批完成
          toast(`本批最后一次任务终止，视为本批完成`, 'warn');
          onBatchComplete();
        }
      } else {
        // === 失败跳过未开启：调度器跟着停止 ===
        schedulerState = 'idle';
        completedBatches = 0;
        remainingRunsAfterSkip = 0;
        originalTotalRuns = 0;
        isSkippingCurrentRun = false;
        clearSchedulerState();
        updateUI();
        toast('自动运行已停止，调度器已关闭', 'info');
      }
      return;
    }
  }

  // ============================================================
  // Toast Helper
  // ============================================================

  function toast(msg, level, duration) {
    if (typeof showToast === 'function') {
      showToast('[调度] ' + msg, level || 'info', duration || 2500);
    } else {
      console.log('[scheduler-addon]', msg);
    }
  }

  // ============================================================
  // Event Bindings
  // ============================================================

  function bindEvents() {
    // 折叠/展开
    const header = document.getElementById('scheduler-addon-header');
    header?.addEventListener('click', () => {
      const expanded = !elCard.classList.contains('is-expanded');
      elCard.classList.toggle('is-expanded', expanded);
      saveExpanded(expanded);
    });

    // 启动
    elBtnStart?.addEventListener('click', () => {
      startScheduler();
      toast('定时调度已启动', 'success');
    });

    // 停止
    elBtnStop?.addEventListener('click', () => {
      stopScheduler();
    });

    // 配置变更自动保存
    elIntervalInput?.addEventListener('change', saveConfig);
    elRunsInput?.addEventListener('change', saveConfig);
    elAutoSkipToggle?.addEventListener('change', saveConfig);

    // 监听 AUTO_RUN_STATUS 消息
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === 'AUTO_RUN_STATUS') {
        onAutoRunStatus(message.payload);
      }
    });
  }

  // ============================================================
  // Init
  // ============================================================

  function init() {
    if (!buildUI()) return;

    loadConfig();

    // 恢复折叠状态
    if (loadExpanded()) {
      elCard.classList.add('is-expanded');
    }

    bindEvents();

    // 恢复调度器运行状态
    loadSchedulerState();
    updateUI();

    console.log('[scheduler-addon] Initialized.');
  }

  // 等待 DOM 就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // sidepanel.js 应该已经加载完毕（因为我们在它之后）
    // 使用 setTimeout 确保 sidepanel.js 全局变量已初始化
    setTimeout(init, 0);
  }
})();
