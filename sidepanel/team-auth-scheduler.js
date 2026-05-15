/**
 * Team Auth Scheduler — 定时调度器（team-auth-addon 专用）
 *
 * 与 scheduler-addon.js 逻辑一致，但面向 team-auth-addon 页面：
 * - 通过 window.TeamAuthAddon.start(N) 启动批次
 * - 通过 document 上的 ta-batch-complete / ta-batch-stopped 事件感知执行状态
 * - 间隔 N 分钟、每批 M 次，循环执行
 */
(function initTeamAuthScheduler() {
  'use strict';

  // ============================================================
  // Constants
  // ============================================================

  const STORAGE_PREFIX = 'ta-scheduler-';
  const STORAGE_KEYS = {
    intervalMinutes: STORAGE_PREFIX + 'interval-minutes',
    runsPerBatch:    STORAGE_PREFIX + 'runs-per-batch',
    autoSkipFailure: STORAGE_PREFIX + 'auto-skip-failure',
    expanded:        STORAGE_PREFIX + 'expanded',
    state:           STORAGE_PREFIX + 'state',
    nextFireAt:      STORAGE_PREFIX + 'next-fire-at',
    completedBatches: STORAGE_PREFIX + 'completed-batches',
    batchSucceeded:  STORAGE_PREFIX + 'batch-succeeded',
    batchFailed:     STORAGE_PREFIX + 'batch-failed',
    totalSucceeded:  STORAGE_PREFIX + 'total-succeeded',
    totalFailed:     STORAGE_PREFIX + 'total-failed',
  };

  const DEFAULT_INTERVAL_MINUTES = 30;
  const DEFAULT_RUNS_PER_BATCH = 5;
  const MIN_INTERVAL_MINUTES = 1;
  const MAX_INTERVAL_MINUTES = 1440;
  const MIN_RUNS_PER_BATCH = 1;
  const MAX_RUNS_PER_BATCH = 999;

  // ============================================================
  // State
  // ============================================================

  /** @type {'idle' | 'running' | 'waiting' | 'stopping'} */
  let schedulerState = 'idle';
  let completedBatches = 0;
  let waitingTimerId = null;
  let countdownTimerId = null;
  let nextFireAt = 0;

  // ---- 批次统计 ----
  let batchSucceeded = 0;
  let batchFailed = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  // ============================================================
  // DOM References
  // ============================================================

  let elCard, elBadge, elChevron, elBody;
  let elIntervalInput, elRunsInput;
  let elAutoSkipToggle;
  let elBtnStart, elBtnStop;
  let elStatus, elCountdown;

  // ============================================================
  // Persistence Helpers
  // ============================================================

  function saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEYS.intervalMinutes, String(getIntervalMinutes()));
      localStorage.setItem(STORAGE_KEYS.runsPerBatch, String(getRunsPerBatch()));
      localStorage.setItem(STORAGE_KEYS.autoSkipFailure, elAutoSkipToggle?.checked ? '1' : '0');
    } catch (_) { /* ignore */ }
  }

  function loadConfig() {
    try {
      const interval = parseInt(localStorage.getItem(STORAGE_KEYS.intervalMinutes), 10);
      const runs = parseInt(localStorage.getItem(STORAGE_KEYS.runsPerBatch), 10);
      const autoSkip = localStorage.getItem(STORAGE_KEYS.autoSkipFailure);
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
      localStorage.setItem(STORAGE_KEYS.batchSucceeded, String(batchSucceeded));
      localStorage.setItem(STORAGE_KEYS.batchFailed, String(batchFailed));
      localStorage.setItem(STORAGE_KEYS.totalSucceeded, String(totalSucceeded));
      localStorage.setItem(STORAGE_KEYS.totalFailed, String(totalFailed));
    } catch (_) { /* ignore */ }
  }

  function loadSchedulerState() {
    try {
      const state = localStorage.getItem(STORAGE_KEYS.state);
      const fireAt = parseInt(localStorage.getItem(STORAGE_KEYS.nextFireAt), 10);
      const batches = parseInt(localStorage.getItem(STORAGE_KEYS.completedBatches), 10);

      if (state === 'running' || state === 'waiting' || state === 'stopping') {
        schedulerState = state;
      }
      if (Number.isFinite(batches) && batches >= 0) completedBatches = batches;

      const bs = parseInt(localStorage.getItem(STORAGE_KEYS.batchSucceeded), 10);
      const bf = parseInt(localStorage.getItem(STORAGE_KEYS.batchFailed), 10);
      const ts = parseInt(localStorage.getItem(STORAGE_KEYS.totalSucceeded), 10);
      const tf = parseInt(localStorage.getItem(STORAGE_KEYS.totalFailed), 10);
      if (Number.isFinite(bs) && bs >= 0) batchSucceeded = bs;
      if (Number.isFinite(bf) && bf >= 0) batchFailed = bf;
      if (Number.isFinite(ts) && ts >= 0) totalSucceeded = ts;
      if (Number.isFinite(tf) && tf >= 0) totalFailed = tf;

      // 恢复等待状态
      if (schedulerState === 'waiting' && Number.isFinite(fireAt) && fireAt > Date.now()) {
        nextFireAt = fireAt;
        startWaitingTimer(fireAt - Date.now());
      } else if (schedulerState === 'waiting') {
        // 等待时间已过，立即开始下一批
        nextFireAt = 0;
        startNextBatch();
      }
      // running 状态：页面重载但 team-auth-addon 可能已不在运行，检查并修正
      if (schedulerState === 'running') {
        // 延迟检查，等待 team-auth-addon 初始化
        setTimeout(() => {
          if (schedulerState === 'running' && !window.TeamAuthAddon?.isRunning) {
            // team-auth-addon 已停止但调度器仍认为在运行，可能是页面重载导致
            // 按照失败跳过策略决定下一步
            if (isAutoSkipFailure()) {
              onBatchComplete();
            } else {
              finishStopping();
            }
          }
        }, 2000);
      }
    } catch (_) { /* ignore */ }
  }

  function clearSchedulerState() {
    try {
      Object.values(STORAGE_KEYS).forEach(key => {
        if (key !== STORAGE_KEYS.intervalMinutes &&
            key !== STORAGE_KEYS.runsPerBatch &&
            key !== STORAGE_KEYS.autoSkipFailure &&
            key !== STORAGE_KEYS.expanded) {
          localStorage.removeItem(key);
        }
      });
    } catch (_) { /* ignore */ }
  }

  function saveExpanded(expanded) {
    try { localStorage.setItem(STORAGE_KEYS.expanded, expanded ? '1' : '0'); } catch (_) { /* ignore */ }
  }

  function loadExpanded() {
    try { return localStorage.getItem(STORAGE_KEYS.expanded) === '1'; } catch (_) { return false; }
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

  function isAutoSkipFailure() {
    return Boolean(elAutoSkipToggle?.checked);
  }

  // ============================================================
  // Toast Helper
  // ============================================================

  function toast(msg, level, duration) {
    const U = window.TeamAuthUtils;
    if (U && typeof U.showToast === 'function') {
      U.showToast('[调度] ' + msg, level || 'info', duration || 2500);
    } else {
      console.log('[ta-scheduler]', msg);
    }
  }

  // ============================================================
  // UI Builder
  // ============================================================

  function buildUI() {
    // 在 #ta-actions-section 之前插入调度器面板
    const actionsSection = document.getElementById('ta-actions-section');
    if (!actionsSection) {
      console.warn('[ta-scheduler] #ta-actions-section not found, cannot inject UI.');
      return false;
    }

    const container = document.createElement('section');
    container.className = 'ta-section ta-scheduler';
    container.innerHTML = `
      <div class="ta-scheduler-card" id="ta-scheduler-card">
        <div class="ta-scheduler-header" id="ta-scheduler-header">
          <div class="ta-scheduler-header-left">
            <span class="section-label">定时调度</span>
            <span class="ta-scheduler-badge" id="ta-scheduler-badge" data-state="idle">空闲</span>
          </div>
          <svg class="ta-scheduler-chevron" id="ta-scheduler-chevron" width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </div>
        <div class="ta-scheduler-body" id="ta-scheduler-body">
          <div class="ta-scheduler-row">
            <span class="ta-scheduler-label">间隔时间</span>
            <div class="ta-scheduler-controls">
              <input type="number" id="ta-scheduler-interval" class="ta-input"
                value="${DEFAULT_INTERVAL_MINUTES}" min="${MIN_INTERVAL_MINUTES}" max="${MAX_INTERVAL_MINUTES}" step="1" />
              <span class="ta-unit">分钟</span>
            </div>
          </div>
          <div class="ta-scheduler-row">
            <span class="ta-scheduler-label">每批次数</span>
            <div class="ta-scheduler-controls">
              <input type="number" id="ta-scheduler-runs" class="ta-input"
                value="${DEFAULT_RUNS_PER_BATCH}" min="${MIN_RUNS_PER_BATCH}" max="${MAX_RUNS_PER_BATCH}" step="1" />
              <span class="ta-unit">次/批</span>
            </div>
          </div>
          <div class="ta-scheduler-row">
            <span class="ta-scheduler-label">失败跳过</span>
            <div class="ta-scheduler-controls">
              <label class="ta-scheduler-toggle">
                <input type="checkbox" id="ta-scheduler-auto-skip" />
                <span class="ta-scheduler-toggle-track">
                  <span class="ta-scheduler-toggle-thumb"></span>
                </span>
                <span>批次失败时自动跳到下一批</span>
              </label>
            </div>
          </div>
          <div class="ta-scheduler-actions">
            <button id="ta-scheduler-btn-start" class="btn btn-primary btn-sm" type="button">启动调度</button>
            <button id="ta-scheduler-btn-stop" class="btn btn-danger btn-sm" type="button" disabled>停止调度</button>
          </div>
          <div class="ta-scheduler-status" id="ta-scheduler-status">
            <div class="ta-scheduler-status-line">
              <span class="ta-scheduler-status-dot is-idle" id="ta-scheduler-status-dot"></span>
              <span id="ta-scheduler-status-text">调度器未启动</span>
            </div>
            <div class="ta-scheduler-status-line" id="ta-scheduler-batch-stats-line" style="display:none;">
              <span id="ta-scheduler-batch-stats" class="ta-scheduler-stats"></span>
            </div>
            <div class="ta-scheduler-status-line" id="ta-scheduler-total-stats-line" style="display:none;">
              <span id="ta-scheduler-total-stats" class="ta-scheduler-stats"></span>
            </div>
            <div class="ta-scheduler-status-line" id="ta-scheduler-countdown-line" style="display:none;">
              <span>下一批启动：</span>
              <span class="ta-scheduler-countdown" id="ta-scheduler-countdown">--:--</span>
            </div>
          </div>
        </div>
      </div>
    `;

    actionsSection.parentNode.insertBefore(container, actionsSection);

    // Cache DOM references
    elCard = document.getElementById('ta-scheduler-card');
    elBadge = document.getElementById('ta-scheduler-badge');
    elChevron = document.getElementById('ta-scheduler-chevron');
    elBody = document.getElementById('ta-scheduler-body');
    elIntervalInput = document.getElementById('ta-scheduler-interval');
    elRunsInput = document.getElementById('ta-scheduler-runs');
    elAutoSkipToggle = document.getElementById('ta-scheduler-auto-skip');
    elBtnStart = document.getElementById('ta-scheduler-btn-start');
    elBtnStop = document.getElementById('ta-scheduler-btn-stop');
    elStatus = document.getElementById('ta-scheduler-status');
    elCountdown = document.getElementById('ta-scheduler-countdown');

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
      idle:     { text: '空闲',   state: 'idle' },
      running:  { text: '运行中', state: 'running' },
      waiting:  { text: '等待中', state: 'waiting' },
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
    const statusDot = document.getElementById('ta-scheduler-status-dot');
    const statusText = document.getElementById('ta-scheduler-status-text');
    const countdownLine = document.getElementById('ta-scheduler-countdown-line');

    elStatus.classList.toggle('is-visible', isActive);

    if (statusDot) {
      statusDot.className = 'ta-scheduler-status-dot';
      if (schedulerState === 'running') statusDot.classList.add('is-running');
      else if (schedulerState === 'waiting') statusDot.classList.add('is-waiting');
      else statusDot.classList.add('is-idle');
    }

    if (statusText) {
      switch (schedulerState) {
        case 'running': {
          const progress = batchSucceeded + batchFailed;
          let runningText = `第 ${completedBatches + 1} 批运行中`;
          if (progress > 0) {
            runningText += `（${progress}/${getRunsPerBatch()}`;
            if (batchFailed > 0) runningText += ` · 失败 ${batchFailed}`;
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
    const batchStatsLine = document.getElementById('ta-scheduler-batch-stats-line');
    const batchStatsEl = document.getElementById('ta-scheduler-batch-stats');
    if (batchStatsLine && batchStatsEl) {
      const showBatchStats = (schedulerState === 'waiting' || schedulerState === 'running') && (batchSucceeded > 0 || batchFailed > 0);
      batchStatsLine.style.display = showBatchStats ? '' : 'none';
      if (showBatchStats) {
        const label = schedulerState === 'waiting' ? '上批结果' : '本批进度';
        batchStatsEl.textContent = `${label}：✓ ${batchSucceeded}  ✗ ${batchFailed}  共 ${batchSucceeded + batchFailed}`;
      }
    }

    // Total stats line
    const totalStatsLine = document.getElementById('ta-scheduler-total-stats-line');
    const totalStatsEl = document.getElementById('ta-scheduler-total-stats');
    if (totalStatsLine && totalStatsEl) {
      const showTotalStats = isActive && (totalSucceeded > 0 || totalFailed > 0);
      totalStatsLine.style.display = showTotalStats ? '' : 'none';
      if (showTotalStats) {
        totalStatsEl.textContent = `累计：✓ ${totalSucceeded}  ✗ ${totalFailed}  共 ${totalSucceeded + totalFailed}`;
      }
    }

    if (countdownLine) {
      countdownLine.style.display = schedulerState === 'waiting' ? '' : 'none';
    }

    // 同步更新主面板的开始/停止按钮状态
    updateMainButtons();
  }

  /** 调度器活跃时禁用主面板的手动启动按钮，避免冲突 */
  function updateMainButtons() {
    const mainStart = document.getElementById('btn-start');
    const mainRunCount = document.getElementById('input-run-count');
    const isActive = schedulerState !== 'idle';
    if (mainStart && isActive && !window.TeamAuthAddon?.isRunning) {
      mainStart.disabled = true;
    }
    if (mainRunCount && isActive && !window.TeamAuthAddon?.isRunning) {
      mainRunCount.disabled = true;
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
    if (window.TeamAuthAddon?.isRunning) {
      toast('当前有任务正在运行，请等待完成后再启动调度', 'warn');
      return;
    }

    saveConfig();
    completedBatches = 0;
    batchSucceeded = 0;
    batchFailed = 0;
    totalSucceeded = 0;
    totalFailed = 0;

    // 无首次延迟，直接启动第一批
    schedulerState = 'running';
    saveSchedulerState();
    updateUI();
    startBatchRun();
  }

  function stopScheduler() {
    if (schedulerState === 'idle') return;

    const wasRunning = schedulerState === 'running';
    schedulerState = 'stopping';
    updateUI();

    // 清除所有定时器
    if (waitingTimerId) { clearTimeout(waitingTimerId); waitingTimerId = null; }
    if (countdownTimerId) { clearInterval(countdownTimerId); countdownTimerId = null; }

    nextFireAt = 0;

    // 如果当前正在运行自动任务，发送停止
    if (wasRunning && window.TeamAuthAddon?.isRunning) {
      window.TeamAuthAddon.stop();
      // 超时保底：如果 5 秒内没收到事件回调，强制清理
      setTimeout(() => {
        if (schedulerState === 'stopping') {
          finishStopping();
        }
      }, 5000);
    } else {
      finishStopping();
    }
  }

  function finishStopping() {
    // 停止前先 toast 出累计统计
    if (totalSucceeded > 0 || totalFailed > 0) {
      toast(`累计统计：✓ ${totalSucceeded}  ✗ ${totalFailed}  共 ${totalSucceeded + totalFailed}`, 'info', 4000);
    }
    schedulerState = 'idle';
    completedBatches = 0;
    batchSucceeded = 0;
    batchFailed = 0;
    totalSucceeded = 0;
    totalFailed = 0;
    clearSchedulerState();
    updateUI();
    toast('定时调度已停止', 'info');

    // 恢复主面板按钮
    const mainStart = document.getElementById('btn-start');
    const mainRunCount = document.getElementById('input-run-count');
    if (mainStart) mainStart.disabled = false;
    if (mainRunCount) mainRunCount.disabled = false;
  }

  function startNextBatch() {
    if (schedulerState !== 'waiting' && schedulerState !== 'running') return;

    schedulerState = 'running';
    batchSucceeded = 0;
    batchFailed = 0;
    saveSchedulerState();
    updateUI();

    startBatchRun();
  }

  function startBatchRun() {
    const runsPerBatch = getRunsPerBatch();
    saveSchedulerState();

    toast(`第 ${completedBatches + 1} 批启动（${runsPerBatch} 次）`, 'info');

    // 通过暴露的 API 启动执行，传入批次次数
    window.TeamAuthAddon.start(runsPerBatch);
  }

  function onBatchComplete() {
    if (schedulerState !== 'running') return;

    completedBatches += 1;

    const intervalMs = getIntervalMinutes() * 60 * 1000;
    nextFireAt = Date.now() + intervalMs;
    schedulerState = 'waiting';
    saveSchedulerState();
    updateUI();

    toast(`第 ${completedBatches} 批已完成（✓${batchSucceeded} ✗${batchFailed}），${getIntervalMinutes()} 分钟后开始下一批`, 'info');

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
      if (countdownTimerId) { clearInterval(countdownTimerId); countdownTimerId = null; }
      nextFireAt = 0;

      if (schedulerState === 'waiting') {
        startNextBatch();
      }
    }, delayMs);
  }

  // ============================================================
  // Event Handlers — 监听 team-auth-addon 的批次事件
  // ============================================================

  function handleBatchComplete(event) {
    if (schedulerState === 'stopping') {
      finishStopping();
      return;
    }
    if (schedulerState !== 'running') return;

    const detail = event.detail || {};
    const runs = detail.completedRuns || 0;

    batchSucceeded += runs;
    totalSucceeded += runs;
    saveSchedulerState();

    onBatchComplete();
  }

  function handleBatchStopped(event) {
    if (schedulerState === 'stopping') {
      finishStopping();
      return;
    }
    if (schedulerState !== 'running') return;

    const detail = event.detail || {};
    const succeeded = detail.completedRuns || 0;
    const total = detail.totalRuns || 0;
    const failed = Math.max(0, total - succeeded);

    batchSucceeded += succeeded;
    batchFailed += failed;
    totalSucceeded += succeeded;
    totalFailed += failed;
    saveSchedulerState();

    if (isAutoSkipFailure()) {
      // 失败跳过已开启：进入等待下一批
      toast(`本批中断（完成 ${succeeded}/${total}），自动跳过，等待下一批`, 'warn');
      onBatchComplete();
    } else {
      // 失败跳过未开启：调度器跟着停止
      finishStopping();
      toast('批次中断，调度器已停止（未开启失败跳过）', 'warn');
    }
  }

  // ============================================================
  // Event Bindings
  // ============================================================

  function bindEvents() {
    // 折叠/展开
    const header = document.getElementById('ta-scheduler-header');
    header?.addEventListener('click', () => {
      const expanded = !elCard.classList.contains('is-expanded');
      elCard.classList.toggle('is-expanded', expanded);
      saveExpanded(expanded);
    });

    // 启动
    elBtnStart?.addEventListener('click', () => {
      startScheduler();
    });

    // 停止
    elBtnStop?.addEventListener('click', () => {
      stopScheduler();
    });

    // 配置变更自动保存
    elIntervalInput?.addEventListener('change', saveConfig);
    elRunsInput?.addEventListener('change', saveConfig);
    elAutoSkipToggle?.addEventListener('change', saveConfig);

    // 监听 team-auth-addon 的批次事件
    document.addEventListener('ta-batch-complete', handleBatchComplete);
    document.addEventListener('ta-batch-stopped', handleBatchStopped);
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

    console.log('[ta-scheduler] Initialized.');
  }

  // 等待 DOM 就绪 + team-auth-addon.js 初始化完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 50));
  } else {
    setTimeout(init, 50);
  }
})();
