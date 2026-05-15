/* team-auth-addon.js — Team Auth 主控制逻辑 */
(function () {
  'use strict';

  // ============================================================
  // Scheduler Integration — 调度器可通过 window.TeamAuthAddon 调用
  // ============================================================
  /** @type {number|null} 由调度器设置的覆盖运行次数，为 null 时使用 UI 输入框的值 */
  let schedulerRunCountOverride = null;
  const U = window.TeamAuthUtils;
  const Steps = window.TeamAuthSteps;

  // ============================================================
  // State
  // ============================================================
  let currentMode = 'full'; // 'full' | 'cert-only'
  let seatType = 'Codex';   // 'Codex' | 'ChatGPT'
  let isRunning = false;
  let stopRequested = false;
  let aliases = [];
  let certifiedEmails = new Set();
  let currentEmail = '';
  let inviteUrl = '';   // 步骤间共享的邀请链接

  // ============================================================
  // DOM References
  // ============================================================
  const $ = (id) => document.getElementById(id);
  const btnModes = document.querySelectorAll('.ta-mode-btn');
  const btnSeats = document.querySelectorAll('.ta-seat-btn');
  const btnStart = $('btn-start');
  const btnStop = $('btn-stop');
  const btnClearLog = $('btn-clear-log');
  const btnIcloudRefresh = $('btn-icloud-refresh');
  const btnIcloudLoginDone = $('btn-icloud-login-done');
  const inputRunCount = $('input-run-count');
  const modeHint = $('ta-mode-hint');
  const statusText = $('ta-status-text');
  const stepsList = $('ta-steps-list');
  const progressCounter = $('ta-progress-counter');
  const logArea = $('ta-log-area');
  const icloudList = $('ta-icloud-list');
  const icloudSummary = $('ta-icloud-summary');
  const icloudLoginHelp = $('ta-icloud-login-help');
  const icloudFilter = $('ta-icloud-filter');
  const icloudSearch = $('ta-icloud-search');

  // ============================================================
  // Step Definitions
  // ============================================================
  // 步骤顺序说明：
  // 1-5 注册子账号 → 6 等待注册成功 → 7-9 邀请进团队 → 10-13 OAuth → 14 清理子账号
  // 步骤 6 已从"清理 GPT Cookies"改为"等待注册成功"（与原代码对齐），
  // 等待 20 秒确认注册成功并让页面稳定后再继续后续流程。
  const FULL_STEPS = [
    { id: 1, key: 'open-chatgpt', title: '打开 ChatGPT 官网' },
    { id: 2, key: 'submit-signup-email', title: '注册并输入邮箱' },
    { id: 3, key: 'fill-password', title: '填写密码并继续' },
    { id: 4, key: 'fetch-signup-code', title: '获取注册验证码' },
    { id: 5, key: 'fill-profile', title: '填写姓名和生日' },
    { id: 6, key: 'wait-registration-success', title: '等待注册成功' },
    { id: 7, key: 'invite-member', title: '邀请成员进团队', isNew: true },
    { id: 8, key: 'fetch-invite-email', title: '获取邀请邮件', isNew: true },
    { id: 9, key: 'accept-invite', title: '接受 Codex 邀请', isNew: true },
    { id: 10, key: 'oauth-login', title: '刷新 OAuth 并登录' },
    { id: 11, key: 'fetch-login-code', title: '获取登录验证码' },
    { id: 12, key: 'confirm-oauth', title: '自动确认 OAuth' },
    { id: 13, key: 'platform-verify', title: '平台回调验证' },
    { id: 14, key: 'remove-member', title: '清理团队子账号', isNew: true },
  ];

  const CERT_ONLY_STEPS = [
    { id: 1, key: 'pick-email', title: '获取未使用隐私邮箱' },
    { id: 2, key: 'invite-member', title: '邀请成员进团队', isNew: true },
    { id: 3, key: 'fetch-invite-email', title: '获取邀请邮件', isNew: true },
    { id: 4, key: 'accept-invite', title: '接受 Codex 邀请', isNew: true },
    { id: 5, key: 'oauth-login', title: '刷新 OAuth 并登录' },
    { id: 6, key: 'fetch-login-code', title: '获取登录验证码' },
    { id: 7, key: 'confirm-oauth', title: '自动确认 OAuth' },
    { id: 8, key: 'platform-verify', title: '平台回调验证' },
    { id: 9, key: 'remove-member', title: '清理团队子账号', isNew: true },
  ];

  function getSteps() { return currentMode === 'full' ? FULL_STEPS : CERT_ONLY_STEPS; }

  // ============================================================
  // Step Status Tracking
  // ============================================================
  let stepStatuses = {}; // id -> 'pending'|'running'|'done'|'error'|'skipped'

  function resetStepStatuses() {
    stepStatuses = {};
    getSteps().forEach(s => { stepStatuses[s.id] = 'pending'; });
  }

  // ============================================================
  // Context Display — 显示步骤间传递的参数
  // ============================================================
  function updateContextDisplay() {
    const ctxEmail = $('ctx-email');
    const ctxInvite = $('ctx-invite-url');
    if (ctxEmail) ctxEmail.textContent = currentEmail || '未获取';
    if (ctxInvite) ctxInvite.textContent = inviteUrl || '未获取';
  }

  // ============================================================
  // Logging
  // ============================================================
  function addLog(msg, level) {
    const line = document.createElement('div');
    line.className = 'ta-log-line is-' + (level || 'info');
    line.innerHTML = `<span class="ta-log-time">${U.formatTime()}</span><span class="ta-log-msg">${U.escapeHtml(msg)}</span>`;
    logArea.appendChild(line);
    logArea.scrollTop = logArea.scrollHeight;
    console.log(`[team-auth] [${level}] ${msg}`);
    return Promise.resolve();
  }

  function throwIfStopped() {
    if (stopRequested) throw new Error('用户已停止');
  }

  // ============================================================
  // Render Steps — 每行可点击执行单步
  // ============================================================
  function renderSteps() {
    stepsList.innerHTML = '';
    const steps = getSteps();
    let doneCount = 0;
    steps.forEach(step => {
      const status = stepStatuses[step.id] || 'pending';
      if (status === 'done') doneCount++;
      const row = document.createElement('div');
      row.className = 'ta-step-row is-clickable' + (status !== 'pending' ? ' is-' + status : '');
      row.dataset.stepId = step.id;
      row.title = `点击单独执行：${step.title}`;
      const statusLabel = { pending: '', running: '执行中', done: '✓', error: '✗', skipped: '跳过' }[status] || '';
      const newTag = step.isNew ? ' <span class="ta-step-tag is-new">新增</span>' : '';
      row.innerHTML =
        `<div class="ta-step-indicator">${step.id}</div>` +
        `<span class="ta-step-title">${U.escapeHtml(step.title)}${newTag}</span>` +
        `<span class="ta-step-status">${statusLabel}</span>`;
      // 点击执行单步
      row.addEventListener('click', () => onStepClick(step));
      stepsList.appendChild(row);
    });
    progressCounter.textContent = `${doneCount} / ${steps.length}`;
  }

  function setStepStatus(stepId, status) {
    stepStatuses[stepId] = status;
    renderSteps();
  }

  // ============================================================
  // iCloud Alias Management
  // ============================================================
  function loadCertifiedEmails() {
    try {
      const data = localStorage.getItem('team-auth-certified-emails');
      certifiedEmails = new Set(data ? JSON.parse(data) : []);
    } catch { certifiedEmails = new Set(); }
  }

  function saveCertifiedEmails() {
    localStorage.setItem('team-auth-certified-emails', JSON.stringify([...certifiedEmails]));
  }

  function markAsCertified(email) {
    certifiedEmails.add(email.toLowerCase());
    saveCertifiedEmails();
  }

  async function refreshIcloudAliases() {
    icloudSummary.textContent = '正在加载 iCloud 别名...';
    try {
      const resp = await U.sendBgMessage({ type: 'LIST_ICLOUD_ALIASES', source: 'team-auth-addon', payload: {} });
      if (resp?.error) {
        if (resp.error.includes('登录') || resp.error.includes('login') || resp.error.includes('sign in')) {
          showIcloudLoginHelp(resp);
        }
        throw new Error(resp.error);
      }
      hideIcloudLoginHelp();
      aliases = resp?.aliases || [];
      renderIcloudList();
      U.showToast(`已加载 ${aliases.length} 个别名`, 'success', 2000);
    } catch (err) {
      icloudSummary.textContent = err.message;
      icloudList.innerHTML = '<div class="ta-icloud-empty">加载失败</div>';
      U.showToast(`加载失败：${err.message}`, 'error');
    }
  }

  function showIcloudLoginHelp(resp) {
    if (icloudLoginHelp) icloudLoginHelp.style.display = 'flex';
  }

  function hideIcloudLoginHelp() {
    if (icloudLoginHelp) icloudLoginHelp.style.display = 'none';
  }

  function getFilteredAliases() {
    const filter = icloudFilter?.value || 'all';
    const search = (icloudSearch?.value || '').trim().toLowerCase();
    return aliases.filter(a => {
      if (filter === 'unused') return !a.used && a.active;
      if (filter === 'used') return a.used;
      if (filter === 'certified') return certifiedEmails.has(a.email);
      return true;
    }).filter(a => {
      if (!search) return true;
      return a.email.toLowerCase().includes(search) || (a.label || '').toLowerCase().includes(search);
    });
  }

  function renderIcloudList() {
    const filtered = getFilteredAliases();
    const usedCount = aliases.filter(a => a.used).length;
    const certCount = aliases.filter(a => certifiedEmails.has(a.email)).length;
    icloudSummary.textContent = `共 ${aliases.length} 个别名，${usedCount} 个已用，${certCount} 个已认证`;
    icloudList.innerHTML = '';

    if (!filtered.length) {
      icloudList.innerHTML = '<div class="ta-icloud-empty">没有匹配的别名</div>';
      return;
    }

    for (const alias of filtered) {
      const item = document.createElement('div');
      item.className = 'ta-icloud-item';
      const isCert = certifiedEmails.has(alias.email);
      item.innerHTML =
        `<div class="ta-icloud-item-main">` +
        `<div class="ta-icloud-item-email">${U.escapeHtml(alias.email)}</div>` +
        `<div class="ta-icloud-item-meta">` +
        (alias.used ? '<span class="ta-icloud-tag used">已用</span>' : '') +
        (!alias.used && alias.active ? '<span class="ta-icloud-tag active">可用</span>' : '') +
        (isCert ? '<span class="ta-icloud-tag certified">已认证</span>' : '') +
        (alias.label ? `<span class="ta-icloud-tag">${U.escapeHtml(alias.label)}</span>` : '') +
        `</div></div>`;
      icloudList.appendChild(item);
    }
  }

  function pickNextUnusedAlias() {
    return aliases.find(a => a.active && !a.used && !certifiedEmails.has(a.email)) || null;
  }

  // ============================================================
  // Email Prefetch — 模拟原 autoRunLoop 轮次准备阶段的邮箱获取
  // ============================================================
  // resolveSignupEmailForFlow 内建处理以下 provider：
  //   - hotmail  → ensureHotmailAccountForFlow
  //   - luckmail → ensureLuckmailPurchaseForFlow
  //   - generatedAlias (gmail/2925) → buildGeneratedAliasEmail
  // 其他 provider（iCloud、Cloudflare、Duck 等）依赖 state.email 已预先设置，
  // 否则会因 state.email 为空抛出"缺少邮箱地址"。
  function needsPrefetchEmail(state) {
    const provider = String(state?.mailProvider || '').trim().toLowerCase();
    // hotmail / luckmail / gmail / 2925(provide模式) 由 resolveSignupEmailForFlow 内部处理
    if (provider === 'hotmail') return false;
    if (provider === 'luckmail') return false;
    // 自定义邮箱：用户需手动粘贴，不自动获取
    if (provider === 'custom') return false;
    // 已有邮箱则无需获取
    if (state?.email) return false;
    // gmail / 2925(provide模式) 由 resolveSignupEmailForFlow 内部的 isGeneratedAliasProvider 分支处理
    if (provider === 'gmail') return false;
    if (provider === '2925') {
      const mail2925Mode = String(state?.mail2925Mode || 'provide').trim().toLowerCase();
      if (mail2925Mode === 'provide') return false;
    }
    // 其余情况（icloud、cloudflare、cloudflare-temp-email、duck、qq、163 等）需要预获取
    return true;
  }

  async function prefetchEmailIfNeeded(state, addLogFn) {
    if (!needsPrefetchEmail(state)) return;

    const generator = String(state?.emailGenerator || state?.mailProvider || '').trim().toLowerCase();
    const icloudFetchMode = String(state?.icloudFetchMode || 'reuse_existing').trim().toLowerCase();
    const isIcloud = generator === 'icloud' || String(state?.mailProvider || '').trim().toLowerCase() === 'icloud';

    await addLogFn(`预获取邮箱：当前 provider=${state?.mailProvider || '未知'}，generator=${generator}，正在通过 background 获取邮箱...`, 'info');

    try {
      const resp = await U.sendBgMessage({
        type: 'FETCH_GENERATED_EMAIL',
        source: 'team-auth-addon',
        payload: {
          generateNew: isIcloud ? (icloudFetchMode === 'always_new') : true,
          generator: generator || undefined,
        },
      });
      if (resp?.error) throw new Error(resp.error);
      if (resp?.email) {
        currentEmail = resp.email;
        await addLogFn(`预获取邮箱成功：${resp.email}`, 'ok');
      }
    } catch (err) {
      await addLogFn(`预获取邮箱失败：${err.message}`, 'error');
      throw err;
    }
  }

  // 步骤完成后的固定延迟（毫秒）—— 与原代码 AUTO_STEP_DELAYS 保持一致
  // 用于等待页面过渡/加载，避免节奏过快导致下一步操作失败
  const POST_STEP_DELAYS = {
    'open-chatgpt': 2000,
    'submit-signup-email': 2000,
    'fill-password': 3000,
    'fetch-signup-code': 2000,
    'fill-profile': 0,
    'clear-login-cookies': 3000,
    'wait-registration-success': 3000,
    'oauth-login': 2000,
    'fetch-login-code': 2000,
    'confirm-oauth': 1000,
    'platform-verify': 0,
    'invite-member': 2000,
    'fetch-invite-email': 1000,
    'accept-invite': 2000,
    'remove-member': 0,
  };

  async function postStepDelay(stepKey) {
    const delay = POST_STEP_DELAYS[stepKey] || 0;
    if (delay > 0) await U.sleep(delay);
  }

  // ============================================================
  // 步间间隔控制
  // ============================================================
  async function getStepDelaySeconds() {
    try {
      const state = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
      const raw = state?.autoStepDelaySeconds;
      if (raw == null || raw === '') return 0;
      const num = Number(raw);
      return Number.isFinite(num) && num > 0 ? Math.min(600, Math.floor(num)) : 0;
    } catch { return 0; }
  }

  async function applyStepDelay(addLogFn, stepLabel) {
    const seconds = await getStepDelaySeconds();
    if (seconds > 0) {
      await addLogFn(`${stepLabel || '步骤'}执行前等待 ${seconds} 秒（步间间隔）`, 'info');
      await U.sleep(seconds * 1000);
      throwIfStopped();
    }
  }

  // ============================================================
  // Original Flow Integration (Steps 1-6, 7-end via AUTO_RUN)
  // ============================================================
  async function runOriginalStepsPhase1(addLogFn) {
    // 执行原步骤 1-6（注册 + 等待注册成功）
    const phase1Keys = ['open-chatgpt', 'submit-signup-email', 'fill-password', 'fetch-signup-code', 'fill-profile', 'wait-registration-success'];
    const steps = getSteps();

    for (const key of phase1Keys) {
      throwIfStopped();
      const step = steps.find(s => s.key === key);
      if (!step) continue;

      // 原步骤ID映射（原流程中的步骤ID）
      const origStepMap = {
        'open-chatgpt': 1, 'submit-signup-email': 2, 'fill-password': 3,
        'fetch-signup-code': 4, 'fill-profile': 5, 'wait-registration-success': 6,
      };
      const origStep = origStepMap[key];

      // 检查 background 中的步骤状态，如果已被标记 skipped 则跳过
      // 例如：步骤 2 完成时发现页面直接到验证码页（无密码页），会自动将步骤 3 标记 skipped
      try {
        const bgState = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
        const bgStatus = bgState?.stepStatuses?.[origStep];
        if (bgStatus === 'skipped') {
          setStepStatus(step.id, 'done');
          await addLogFn(`步骤 ${step.id}：${step.title} 已被自动跳过`, 'warn');
          continue;
        }
      } catch { /* 查询失败不阻断流程 */ }

      await applyStepDelay(addLogFn, `步骤 ${step.id}`);

      // 检查 background 中的步骤是否已完成（completed/manual_completed/skipped）
      // 原代码在步骤 4+ 循环中会检查 isStepDoneStatus，已完成的步骤直接跳过
      try {
        const bgState2 = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
        const bgStatus2 = bgState2?.stepStatuses?.[origStep];
        if (bgStatus2 === 'completed' || bgStatus2 === 'manual_completed') {
          setStepStatus(step.id, 'done');
          await addLogFn(`步骤 ${step.id}：${step.title} 已完成，跳过`, 'info');
          await postStepDelay(key);
          continue;
        }
      } catch { /* 查询失败不阻断流程 */ }

      setStepStatus(step.id, 'running');

      // [CUSTOM] 完整流程模式下，步骤 1 执行前主动清除 OpenAI/ChatGPT cookies
      if (key === 'open-chatgpt') {
        try {
          const removedCount = await U.clearOpenAiCookies();
          await addLogFn(`步骤 ${step.id}：已清除 ${removedCount} 个 OpenAI/ChatGPT cookies`, removedCount > 0 ? 'ok' : 'info');
        } catch (err) {
          await addLogFn(`步骤 ${step.id}：cookie 清除失败（${err.message}），继续执行`, 'warn');
        }
      }

      await addLogFn(`执行步骤 ${step.id}：${step.title}`, 'info');

      try {
        await U.withRetry(async (attempt) => {
          if (attempt > 1) {
            await addLogFn(`步骤 ${step.id}：${step.title} 第 ${attempt} 次重试...`, 'warn');
          }
          // 验证码获取步骤前 F5 刷新 QQ 邮箱（每次重试都刷新）
          await refreshQQMailTabBeforeMailStep(key, addLogFn);
          const resp = await U.sendBgMessage({ type: 'EXECUTE_STEP', source: 'team-auth-addon', payload: { step: origStep } });
          if (resp?.error) throw new Error(resp.error);
          // 重试时给 background 留时间更新状态，避免 waitForStepCompletion 读到旧的 failed
          if (attempt > 1) await U.sleep(1500);
          await waitForStepCompletion(origStep, addLogFn, 120000, attempt > 1 ? 5000 : 0);
        }, {
          maxAttempts: 3,
          delayMs: 3000,
          onRetry: async (attempt, err) => {
            await addLogFn(`步骤 ${step.id}：${step.title} 失败（${err.message}），3s 后重试...`, 'warn');
          },
        });
        setStepStatus(step.id, 'done');
        await addLogFn(`步骤 ${step.id}：${step.title} 完成`, 'ok');
        await postStepDelay(key);
      } catch (err) {
        setStepStatus(step.id, 'error');
        throw err;
      }
    }
  }

  async function waitForStepCompletion(origStep, addLogFn, timeoutMs, gracePeriodMs) {
    const deadline = Date.now() + (timeoutMs || 120000);
    // gracePeriodMs: 重试场景下，在此时间窗口内忽略旧的 failed 状态，等待 background 更新为 running
    const graceDeadline = gracePeriodMs ? Date.now() + gracePeriodMs : 0;
    while (Date.now() < deadline) {
      throwIfStopped();
      try {
        const state = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
        const statuses = state?.stepStatuses || {};
        const status = statuses[origStep];
        if (status === 'completed' || status === 'done' || status === 'skipped') return;
        if (status === 'failed' || status === 'error') {
          // 在宽限期内不立即抛出，等待 background 重新设为 running
          if (Date.now() < graceDeadline) {
            await U.sleep(1000);
            continue;
          }
          throw new Error(`原步骤 ${origStep} 执行失败`);
        }
      } catch (err) {
        if (err.message.includes('用户已停止') || err.message.includes('执行失败')) throw err;
      }
      await U.sleep(2000);
    }
    throw new Error(`步骤 ${origStep} 执行超时`);
  }

  // NOTE: 步骤 6 已从"清理 GPT Cookies"改为"等待注册成功"（由 background 执行），
  // Cookie 清理相关代码已移除。如果未来需要恢复 cookie 清理功能，
  // 可参考 git 历史中的 clearGptCookiesNonIncognito 实现。

  // ============================================================
  // QQ 邮箱预刷新 — 在验证码获取步骤前 F5 刷新 QQ 邮箱 tab
  // ============================================================
  // 原始 content/qq-mail.js 的 refreshInbox() 使用点击刷新按钮，可能不生效。
  // 这里在外部 F5 刷新（location.reload）后等待邮件列表 DOM 加载完成，
  // 确保 background 发送 POLL_EMAIL 时页面数据是最新的。
  const QQ_MAIL_STEP_KEYS = new Set(['fetch-signup-code', 'fetch-login-code']);

  async function refreshQQMailTabBeforeMailStep(stepKey, addLogFn) {
    if (!QQ_MAIL_STEP_KEYS.has(stepKey)) return;

    // 检查邮件提供商是否为 QQ 邮箱
    try {
      const st = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
      const provider = st?.mailProvider || 'qq';
      if (provider !== 'qq') return;
    } catch { return; }

    // 查找 QQ 邮箱 tab
    try {
      const tabs = await chrome.tabs.query({ url: ['*://wx.mail.qq.com/*', '*://mail.qq.com/*'] });
      if (!tabs.length) return;

      const tabId = tabs[0].id;
      await addLogFn('F5 刷新 QQ 邮箱页面以获取最新邮件...', 'info');
      await U.execInTab(tabId, () => { location.reload(); });
      await U.waitForTabLoad(tabId, 15000);

      // 等待邮件列表 DOM 真正加载完成
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const hasMailList = await U.execInTab(tabId, () => {
          return document.querySelectorAll('.mail-list-page-item[data-mailid]').length > 0;
        });
        if (hasMailList) break;
        await U.sleep(800);
      }
    } catch (err) {
      await addLogFn(`QQ 邮箱预刷新失败（${err.message}），继续执行`, 'warn');
    }
  }

  // ============================================================
  // signup-page Tab 预检 — confirm-oauth 前确保 tab 可用
  // ============================================================
  // confirm-oauth.js (原步骤 9) 在 signup-page tab alive 时只激活不重新导航，
  // 如果 tab 已跳到 localhost 错误页或其他非 OAuth 页面，脚本注入会失败：
  //   "Frame with ID 0 is showing error page"
  // 这里在发送 EXECUTE_STEP 之前检查 tab URL，若不是 OAuth 页面则关闭 tab，
  // 使 executeStep9 走 else 分支用 oauthUrl 重新打开。
  const OAUTH_PAGE_URL_PATTERN = /auth\.openai\.com|auth0\.openai\.com|chatgpt\.com\/auth|accounts\.openai\.com/i;

  async function ensureSignupTabForOAuth(addLogFn) {
    try {
      const state = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} }) || {};
      const signupEntry = state.tabRegistry?.['signup-page'];
      const signupTabId = signupEntry?.tabId;
      if (!signupTabId) return; // 无已注册 tab，executeStep9 会自行创建

      let tab;
      try {
        tab = await chrome.tabs.get(signupTabId);
      } catch {
        return; // tab 已不存在
      }

      const url = String(tab.url || '');
      if (OAUTH_PAGE_URL_PATTERN.test(url)) return; // 仍在 OAuth 页面，无需干预

      await addLogFn(
        `检测到认证页 tab 不在 OAuth 页面（当前：${url.slice(0, 100) || 'unknown'}），将关闭后由原流程重新打开`,
        'warn'
      );
      try {
        await chrome.tabs.remove(signupTabId);
      } catch { /* 关闭失败不阻断 */ }
    } catch {
      // 预检失败不阻断主流程
    }
  }

  // 在进入 OAuth 步骤前，预校验密钥配置，避免进入原流程后重试多次才失败
  async function validateOAuthCredentials(addLogFn) {
    const state = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} }) || {};
    const panelMode = state.panelMode || 'cpa';

    if (panelMode === 'codex2api') {
      if (!state.codex2apiUrl) throw new Error('Codex2API 地址未配置，请先在主面板侧边栏填写。');
      if (!state.codex2apiAdminKey) throw new Error('Codex2API 管理密钥未配置，请先在主面板侧边栏填写。');
    } else if (panelMode === 'sub2api') {
      if (!state.sub2apiUrl) throw new Error('SUB2API 地址未配置，请先在主面板侧边栏填写。');
      if (!state.sub2apiEmail) throw new Error('SUB2API 登录邮箱未配置，请先在主面板侧边栏填写。');
      if (!state.sub2apiPassword) throw new Error('SUB2API 登录密码未配置，请先在主面板侧边栏填写。');
    } else {
      // CPA 模式
      if (!state.vpsUrl) throw new Error('CPA 地址未配置，请先在主面板侧边栏填写。');
      if (!state.vpsPassword) throw new Error('CPA 管理密钥未配置，请先在主面板侧边栏填写。');
    }

    await addLogFn(`OAuth 密钥预校验通过（模式：${panelMode.toUpperCase()}）`, 'info');
  }

  async function runOriginalStepsPhase2(addLogFn) {
    // 预校验 OAuth 密钥配置
    await validateOAuthCredentials(addLogFn);

    // 执行原步骤 7-10 (oauth-login, fetch-login-code, confirm-oauth, platform-verify)
    const phase2Map = {
      'oauth-login': 7, 'fetch-login-code': 8, 'confirm-oauth': 9, 'platform-verify': 10,
    };
    const steps = getSteps();

    for (const [key, origStep] of Object.entries(phase2Map)) {
      throwIfStopped();
      const step = steps.find(s => s.key === key);
      if (!step) continue;

      // 检查 background 中的步骤状态，如果已被标记 skipped 则跳过
      // 例如：步骤 7 完成后直接进入 OAuth 授权页，会自动将步骤 8 标记 skipped
      try {
        const bgState = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
        const bgStatus = bgState?.stepStatuses?.[origStep];
        if (bgStatus === 'skipped') {
          setStepStatus(step.id, 'done');
          await addLogFn(`步骤 ${step.id}：${step.title} 已被自动跳过`, 'warn');
          continue;
        }
      } catch { /* 查询失败不阻断流程 */ }

      await applyStepDelay(addLogFn, `步骤 ${step.id}`);

      // 检查 background 中的步骤是否已完成
      try {
        const bgState2 = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
        const bgStatus2 = bgState2?.stepStatuses?.[origStep];
        if (bgStatus2 === 'completed' || bgStatus2 === 'manual_completed') {
          setStepStatus(step.id, 'done');
          await addLogFn(`步骤 ${step.id}：${step.title} 已完成，跳过`, 'info');
          await postStepDelay(key);
          continue;
        }
      } catch { /* 查询失败不阻断流程 */ }

      setStepStatus(step.id, 'running');
      await addLogFn(`执行步骤 ${step.id}：${step.title}`, 'info');

      try {
        await U.withRetry(async (attempt) => {
          if (attempt > 1) {
            await addLogFn(`步骤 ${step.id}：${step.title} 第 ${attempt} 次重试...`, 'warn');
          }
          // 验证码获取步骤前 F5 刷新 QQ 邮箱（每次重试都刷新）
          await refreshQQMailTabBeforeMailStep(key, addLogFn);
          // confirm-oauth 步骤前确保 signup-page tab 可用
          if (key === 'confirm-oauth') {
            await ensureSignupTabForOAuth(addLogFn);
          }
          const payload = { step: origStep };
          if (currentEmail) payload.email = currentEmail;
          const resp = await U.sendBgMessage({ type: 'EXECUTE_STEP', source: 'team-auth-addon', payload });
          if (resp?.error) throw new Error(resp.error);
          if (attempt > 1) await U.sleep(1500);
          await waitForStepCompletion(origStep, addLogFn, 120000, attempt > 1 ? 5000 : 0);
        }, {
          maxAttempts: 3,
          delayMs: 3000,
          onRetry: async (attempt, err) => {
            await addLogFn(`步骤 ${step.id}：${step.title} 失败（${err.message}），3s 后重试...`, 'warn');
          },
        });
        setStepStatus(step.id, 'done');
        await addLogFn(`步骤 ${step.id}：${step.title} 完成`, 'ok');
        await postStepDelay(key);
      } catch (err) {
        setStepStatus(step.id, 'error');
        throw err;
      }
    }
  }

  // ============================================================
  // Single-Step Click Execution — 点击步骤行执行单个步骤
  // ============================================================
  async function onStepClick(step) {
    if (isRunning) return; // 全流程运行中不允许单步
    await executeSingleStep(step);
  }

  async function executeSingleStep(step) {
    isRunning = true;
    stopRequested = false;
    btnStart.disabled = true;
    btnStop.disabled = false;
    statusText.textContent = `单步执行：${step.title}`;

    setStepStatus(step.id, 'running');
    await addLog(`[单步] 执行步骤 ${step.id}：${step.title}`, 'info');

    try {
      // 获取 background state（用于邮件配置等）
      let state = {};
      try {
        state = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} }) || {};
      } catch {}

      const key = step.key;

      // ---- 原流程步骤（通过 background EXECUTE_STEP 执行）----
      const origStepMap = {
        'open-chatgpt': 1, 'submit-signup-email': 2, 'fill-password': 3,
        'fetch-signup-code': 4, 'fill-profile': 5, 'wait-registration-success': 6,
      };
      const phase2Map = {
        'oauth-login': 7, 'fetch-login-code': 8, 'confirm-oauth': 9, 'platform-verify': 10,
      };

      if (origStepMap[key] !== undefined) {
        // 原注册步骤 1-5
        // 步骤 2（submit-signup-email）需要预获取邮箱，和完整流程保持一致
        if (key === 'submit-signup-email') {
          await prefetchEmailIfNeeded(state, addLog);
        }
        const origStep = origStepMap[key];
        const resp = await U.sendBgMessage({ type: 'EXECUTE_STEP', source: 'team-auth-addon', payload: { step: origStep } });
        if (resp?.error) throw new Error(resp.error);
        await waitForStepCompletion(origStep, addLog);
        // 注册步骤完成后尝试获取邮箱
        if (key === 'fill-profile') {
          try {
            const fs = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
            if (fs?.email) currentEmail = fs.email;
          } catch {}
        }
      } else if (phase2Map[key] !== undefined) {
        // OAuth 步骤 7-10
        if (key === 'oauth-login') await validateOAuthCredentials(addLog);
        if (key === 'confirm-oauth') await ensureSignupTabForOAuth(addLog);
        const origStep = phase2Map[key];
        const singlePayload = { step: origStep };
        if (currentEmail) singlePayload.email = currentEmail;
        const resp = await U.sendBgMessage({ type: 'EXECUTE_STEP', source: 'team-auth-addon', payload: singlePayload });
        if (resp?.error) throw new Error(resp.error);
        await waitForStepCompletion(origStep, addLog);
      } else if (key === 'pick-email') {
        // 仅认证模式：选取邮箱
        const alias = pickNextUnusedAlias();
        if (!alias) throw new Error('没有可用的未使用隐私邮箱');
        currentEmail = alias.email;
        await addLog(`选取邮箱：${currentEmail}`, 'ok');
      } else if (key === 'invite-member') {
        if (!currentEmail) throw new Error('缺少邮箱，请先执行前面的步骤获取邮箱');
        await Steps.inviteMemberToTeam(currentEmail, seatType, addLog);
      } else if (key === 'fetch-invite-email') {
        if (!currentEmail) throw new Error('缺少邮箱，请先执行前面的步骤获取邮箱');
        inviteUrl = await Steps.fetchInvitationEmail(currentEmail, state, addLog);
      } else if (key === 'accept-invite') {
        if (!inviteUrl) throw new Error('缺少邀请链接，请先执行"获取邀请邮件"步骤');
        await Steps.acceptCodexInvitation(inviteUrl, addLog);
      } else if (key === 'remove-member') {
        if (!currentEmail) throw new Error('缺少邮箱，请先执行前面的步骤获取邮箱');
        await Steps.removeMemberFromTeam(currentEmail, addLog);
        markAsCertified(currentEmail);
        renderIcloudList();
      }

      setStepStatus(step.id, 'done');
      await addLog(`[单步] 步骤 ${step.id}：${step.title} 完成`, 'ok');
      statusText.textContent = `步骤 ${step.id} 完成`;
    } catch (err) {
      setStepStatus(step.id, 'error');
      await addLog(`[单步] 步骤 ${step.id} 失败：${err.message}`, 'error');
      statusText.textContent = `步骤 ${step.id} 失败`;
      U.showToast(err.message, 'error');
    } finally {
      isRunning = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
      updateContextDisplay();
    }
  }

  // ============================================================
  // Main Execution Flow
  // ============================================================
  async function runSingleRound(roundNum, totalRounds) {
    resetStepStatuses();
    renderSteps();
    currentEmail = '';
    inviteUrl = '';
    updateContextDisplay();
    const steps = getSteps();

    await addLog(`=== 开始第 ${roundNum}/${totalRounds} 轮 ===`, 'info');

    // ★ 重置 background 步骤状态，避免上一轮的 completed 状态导致本轮步骤被跳过
    try {
      await U.sendBgMessage({ type: 'RESET', source: 'team-auth-addon', payload: {} });
      await addLog('background 步骤状态已重置', 'info');
    } catch (err) {
      await addLog(`background 重置失败（${err.message}），继续执行`, 'warn');
    }

    // ★ 将焦点切回非无痕窗口，避免上一轮结束时焦点停留在无痕窗口，
    //   导致本轮原步骤（如步骤 1 打开 ChatGPT）的 tab 被创建在无痕窗口中
    try {
      const allWindows = await chrome.windows.getAll({ populate: false });
      const normalWin = allWindows.find(w => !w.incognito);
      if (normalWin) {
        await chrome.windows.update(normalWin.id, { focused: true });
      }
    } catch { /* 聚焦失败不阻断流程 */ }

    // 获取 state 用于邮件配置
    let state = {};
    try {
      state = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} }) || {};
    } catch {}

    if (currentMode === 'full') {
      // 预获取邮箱：原流程在 autoRunLoop 轮次准备阶段会通过 fetchGeneratedEmail
      // 获取并写入 state.email，但 team-auth-addon 直接 EXECUTE_STEP 跳过了该阶段，
      // 导致 iCloud 等 provider 在步骤 2 的 resolveSignupEmailForFlow 中因 state.email
      // 为空而报错"缺少邮箱地址"。这里模拟原流程的预获取行为。
      await prefetchEmailIfNeeded(state, addLog);
      throwIfStopped();

      // 阶段1：原步骤 1-6（注册 + 等待注册成功）
      await runOriginalStepsPhase1(addLog);
      throwIfStopped();

      // 获取当前注册的邮箱
      try {
        const freshState = await U.sendBgMessage({ type: 'GET_STATE', source: 'team-auth-addon', payload: {} });
        currentEmail = freshState?.email || currentEmail;
        state = freshState || state;
      } catch {}
    } else {
      // 仅认证模式：获取未使用邮箱
      const pickStep = steps.find(s => s.key === 'pick-email');
      if (pickStep) {
        setStepStatus(pickStep.id, 'running');
        const alias = pickNextUnusedAlias();
        if (!alias) throw new Error('没有可用的未使用隐私邮箱');
        currentEmail = alias.email;
        await addLog(`选取邮箱：${currentEmail}`, 'ok');
        setStepStatus(pickStep.id, 'done');
      }
    }
    updateContextDisplay();

    if (!currentEmail) throw new Error('未获取到注册邮箱');

    // 阶段2：Team 邀请（主账号此时仍在登录态，可正常访问 /admin/members）
    const inviteStep = steps.find(s => s.key === 'invite-member');
    if (inviteStep) {
      throwIfStopped();
      await applyStepDelay(addLog, `步骤 ${inviteStep.id}`);
      setStepStatus(inviteStep.id, 'running');
      try {
        await Steps.inviteMemberToTeam(currentEmail, seatType, addLog);
        setStepStatus(inviteStep.id, 'done');
        await postStepDelay('invite-member');
        // ★ 邀请步骤在无痕窗口执行，完成后切回普通窗口，确保后续步骤不在无痕窗口中
        await U.ensureFocusOnNormalWindow();
      } catch (err) { setStepStatus(inviteStep.id, 'error'); throw err; }
    }

    // 阶段3：获取邀请邮件
    const fetchStep = steps.find(s => s.key === 'fetch-invite-email');
    if (fetchStep) {
      throwIfStopped();
      await applyStepDelay(addLog, `步骤 ${fetchStep.id}`);
      setStepStatus(fetchStep.id, 'running');
      try {
        inviteUrl = await Steps.fetchInvitationEmail(currentEmail, state, addLog);
        setStepStatus(fetchStep.id, 'done');
        await postStepDelay('fetch-invite-email');
      } catch (err) { setStepStatus(fetchStep.id, 'error'); throw err; }
    }
    updateContextDisplay();

    // 阶段4：接受邀请
    const acceptStep = steps.find(s => s.key === 'accept-invite');
    if (acceptStep) {
      throwIfStopped();
      await applyStepDelay(addLog, `步骤 ${acceptStep.id}`);
      setStepStatus(acceptStep.id, 'running');
      try {
        await Steps.acceptCodexInvitation(inviteUrl, addLog);
        setStepStatus(acceptStep.id, 'done');
        await postStepDelay('accept-invite');
      } catch (err) { setStepStatus(acceptStep.id, 'error'); throw err; }
    }

    // ★ 确保焦点在普通窗口，避免 OAuth 步骤在无痕窗口中执行
    await U.ensureFocusOnNormalWindow();

    // 阶段5：原步骤 OAuth 认证
    throwIfStopped();
    await runOriginalStepsPhase2(addLog);

    // 阶段6：清理团队子账号
    const removeStep = steps.find(s => s.key === 'remove-member');
    if (removeStep) {
      throwIfStopped();
      await applyStepDelay(addLog, `步骤 ${removeStep.id}`);
      setStepStatus(removeStep.id, 'running');
      try {
        await Steps.removeMemberFromTeam(currentEmail, addLog);
        setStepStatus(removeStep.id, 'done');
      } catch (err) {
        setStepStatus(removeStep.id, 'error');
        await addLog(`清理步骤失败：${err.message}（非致命，流程继续）`, 'warn');
      }
    }

    // 标记为已认证
    markAsCertified(currentEmail);
    renderIcloudList();

    await addLog(`=== 第 ${roundNum}/${totalRounds} 轮完成 ===`, 'ok');
  }

  async function startExecution() {
    if (isRunning) return;
    isRunning = true;
    stopRequested = false;
    btnStart.disabled = true;
    btnStop.disabled = false;
    inputRunCount.disabled = true;

    // 调度器可通过 schedulerRunCountOverride 覆盖运行次数
    const totalRuns = schedulerRunCountOverride != null
      ? schedulerRunCountOverride
      : Math.max(1, parseInt(inputRunCount.value) || 1);
    schedulerRunCountOverride = null; // 用完即清
    statusText.textContent = `运行中 (0/${totalRuns})`;

    let completedRuns = 0;
    try {
      for (let i = 1; i <= totalRuns; i++) {
        throwIfStopped();
        statusText.textContent = `运行中 (${i}/${totalRuns})`;
        await runSingleRound(i, totalRuns);
        completedRuns = i;
      }
      statusText.textContent = `全部 ${totalRuns} 轮完成`;
      await addLog(`=== 全部 ${totalRuns} 轮执行完成 ===`, 'ok');
      U.showToast('全部流程执行完成', 'success');
      // 通知调度器：批次完成
      document.dispatchEvent(new CustomEvent('ta-batch-complete', {
        detail: { completedRuns, totalRuns },
      }));
    } catch (err) {
      statusText.textContent = '已停止';
      await addLog(`流程终止：${err.message}`, 'error');
      U.showToast(err.message, 'error');
      // 通知调度器：批次中断
      document.dispatchEvent(new CustomEvent('ta-batch-stopped', {
        detail: { completedRuns, totalRuns, error: err.message },
      }));
    } finally {
      isRunning = false;
      btnStart.disabled = false;
      btnStop.disabled = true;
      inputRunCount.disabled = false;
    }
  }

  function stopExecution() {
    stopRequested = true;
    statusText.textContent = '正在停止...';
    U.sendBgMessage({ type: 'STOP_FLOW', source: 'team-auth-addon', payload: {} }).catch(() => {});
  }

  // ============================================================
  // Mode Switching
  // ============================================================
  function setMode(mode) {
    currentMode = mode;
    btnModes.forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.mode === mode);
      btn.classList.toggle('btn-outline', btn.dataset.mode !== mode);
    });
    const hints = {
      full: '完整流程：注册 1-5 → 邀请进团队 → 获取邮件 → 接受邀请 → OAuth 认证 → 清理子账号',
      'cert-only': '仅认证：选取隐私邮箱 → 邀请进团队 → 获取邮件 → 接受邀请 → OAuth 认证 → 清理子账号',
    };
    modeHint.textContent = hints[mode] || '';
    resetStepStatuses();
    renderSteps();
  }

  function setSeatType(type) {
    seatType = type;
    btnSeats.forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.seat === type);
      btn.classList.toggle('btn-outline', btn.dataset.seat !== type);
    });
  }

  // ============================================================
  // Theme
  // ============================================================
  function initTheme() {
    const saved = localStorage.getItem('multipage-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    else if (window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.setAttribute('data-theme', 'dark');
  }

  $('btn-theme')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('multipage-theme', next);
  });

  // ============================================================
  // Event Bindings
  // ============================================================
  btnModes.forEach(btn => btn.addEventListener('click', () => {
    if (!isRunning) setMode(btn.dataset.mode);
  }));

  btnSeats.forEach(btn => btn.addEventListener('click', () => {
    if (!isRunning) setSeatType(btn.dataset.seat);
  }));

  btnStart?.addEventListener('click', startExecution);
  btnStop?.addEventListener('click', stopExecution);
  btnClearLog?.addEventListener('click', () => { logArea.innerHTML = ''; });
  btnIcloudRefresh?.addEventListener('click', refreshIcloudAliases);

  btnIcloudLoginDone?.addEventListener('click', async () => {
    btnIcloudLoginDone.disabled = true;
    try {
      const resp = await U.sendBgMessage({ type: 'CHECK_ICLOUD_SESSION', source: 'team-auth-addon', payload: {} });
      if (resp?.error) throw new Error(resp.error);
      hideIcloudLoginHelp();
      U.showToast('iCloud 登录已确认', 'success');
      await refreshIcloudAliases();
    } catch (err) {
      U.showToast(`登录验证失败：${err.message}`, 'warn');
    } finally { btnIcloudLoginDone.disabled = false; }
  });

  icloudFilter?.addEventListener('change', renderIcloudList);
  icloudSearch?.addEventListener('input', renderIcloudList);

  // ============================================================
  // Init
  // ============================================================
  function init() {
    initTheme();
    loadCertifiedEmails();
    resetStepStatuses();
    renderSteps();
    refreshIcloudAliases().catch(() => {});
    console.log('[team-auth-addon] Initialized.');
  }

  // ============================================================
  // Expose API for Scheduler
  // ============================================================
  window.TeamAuthAddon = {
    /** 启动执行（可选传入运行次数覆盖） */
    start(overrideRunCount) {
      if (overrideRunCount != null) {
        schedulerRunCountOverride = Math.max(1, overrideRunCount);
      }
      startExecution();
    },
    /** 停止执行 */
    stop() {
      stopExecution();
    },
    /** 是否正在运行 */
    get isRunning() { return isRunning; },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 0);
  }
})();
