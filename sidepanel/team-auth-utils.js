/* team-auth-utils.js — Team Auth Addon 工具函数 */
(function (root) {
  'use strict';

  function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = String(str || '');
    return el.innerHTML;
  }

  function formatTime(date) {
    const d = date || new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()]
      .map(n => String(n).padStart(2, '0')).join(':');
  }

  function showToast(msg, level, duration) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast-item is-' + (level || 'info');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), duration || 3000);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * 通用重试包装器 —— 将任意异步操作包装为可重试执行
   * @param {Function} fn - 要执行的异步函数
   * @param {Object} [options]
   * @param {number}   [options.maxAttempts=3]   - 最大尝试次数（含首次）
   * @param {number}   [options.delayMs=2000]     - 重试间隔（毫秒）
   * @param {Function} [options.onRetry]          - 每次重试前的回调 (attempt, error) => void
   * @param {Function} [options.shouldRetry]      - 判断是否应重试 (error) => boolean，默认始终重试
   */
  async function withRetry(fn, options = {}) {
    const {
      maxAttempts = 3,
      delayMs = 2000,
      onRetry = null,
      shouldRetry = () => true,
    } = options;
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        // 用户主动停止时不重试
        if (err?.message?.includes('用户已停止')) throw err;
        if (attempt >= maxAttempts || !shouldRetry(err)) throw err;
        if (typeof onRetry === 'function') {
          await onRetry(attempt, err);
        }
        await sleep(delayMs);
      }
    }
    throw lastError;
  }

  async function sendBgMessage(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  // 在目标tab上执行函数
  async function execInTab(tabId, func, args) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args: args || [],
    });
    return results?.[0]?.result;
  }

  // 等待tab加载完成
  async function waitForTabLoad(tabId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') return tab;
      } catch { break; }
      await sleep(500);
    }
    throw new Error(`页面加载超时（等待 ${Math.round((timeoutMs || 15000) / 1000)} 秒）`);
  }

  // 打开或复用 admin 页面（始终强制导航到指定URL）
  // 内置重试：页面加载超时后自动刷新/重新打开并重试
  async function openOrReuseTab(url, matchPattern) {
    return withRetry(async (attempt) => {
      const tabs = await chrome.tabs.query({ url: matchPattern || url });
      if (tabs.length > 0) {
        const existing = tabs[0];
        await chrome.tabs.update(existing.id, { active: true, url });
        await waitForTabLoad(existing.id, 20000);
        return existing.id;
      }
      const tab = await chrome.tabs.create({ url, active: true });
      await waitForTabLoad(tab.id, 25000);
      return tab.id;
    }, {
      maxAttempts: 3,
      delayMs: 2000,
      onRetry: (attempt, err) => {
        console.warn(`[team-auth] openOrReuseTab 第 ${attempt} 次失败（${err.message}），${2}s 后重试...`);
      },
    });
  }

  // 确保 admin 页面停留在 Members tab（点击"用户"按钮切换）
  // 内置重试：导航超时时自动重试
  async function ensureMembersTab(tabId) {
    await sleep(1500);

    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url || '';
      if (currentUrl.includes('tab=members')) return;

      // 点击"用户"按钮切换到成员列表
      const clicked = await execInTab(tabId, () => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(el => el.textContent.trim() === '用户' || el.textContent.trim() === 'Members');
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (clicked) {
        await sleep(1000);
        continue;
      }

      // 按钮未找到，强制导航（带重试）
      await withRetry(async () => {
        await chrome.tabs.update(tabId, { url: 'https://chatgpt.com/admin/members?tab=members' });
        await waitForTabLoad(tabId, 20000);
      }, {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, err) => {
          console.warn(`[team-auth] ensureMembersTab 导航第 ${attempt} 次失败（${err.message}），重试...`);
        },
      });
      await sleep(1500);
    }
  }

  // 查找已有的无痕窗口
  async function findIncognitoWindow() {
    const allWindows = await chrome.windows.getAll({ populate: false });
    return allWindows.find(w => w.incognito) || null;
  }

  // 在已打开的无痕窗口中打开或复用标签页
  async function openOrReuseTabInIncognito(url, matchPattern) {
    const incognitoWin = await findIncognitoWindow();
    if (!incognitoWin) {
      throw new Error('未找到已打开的无痕窗口，请先手动打开一个无痕窗口');
    }

    // 内置重试：页面加载超时后自动刷新/重新打开并重试
    return withRetry(async (attempt) => {
      // 在无痕窗口中查找匹配的标签页
      const tabs = await chrome.tabs.query({
        windowId: incognitoWin.id,
        url: matchPattern || url,
      });

      if (tabs.length > 0) {
        const existing = tabs[0];
        await chrome.windows.update(incognitoWin.id, { focused: true });
        // 重试时强制 reload 以避免页面卡在错误状态
        if (attempt > 1) {
          await chrome.tabs.reload(existing.id);
        } else {
          await chrome.tabs.update(existing.id, { active: true, url });
        }
        await waitForTabLoad(existing.id, 20000);
        return existing.id;
      }

      // 无痕窗口中没有匹配的标签页，新建一个
      await chrome.windows.update(incognitoWin.id, { focused: true });
      const tab = await chrome.tabs.create({ windowId: incognitoWin.id, url, active: true });
      await waitForTabLoad(tab.id, 25000);
      return tab.id;
    }, {
      maxAttempts: 3,
      delayMs: 3000,
      onRetry: (attempt, err) => {
        console.warn(`[team-auth] openOrReuseTabInIncognito 第 ${attempt} 次失败（${err.message}），${3}s 后重试...`);
      },
    });
  }

  // 将焦点切换到非无痕窗口，避免后续 chrome.tabs.create 在无痕窗口中创建标签页
  async function ensureFocusOnNormalWindow() {
    const allWindows = await chrome.windows.getAll({ populate: false });
    const normalWin = allWindows.find(w => !w.incognito);
    if (normalWin) {
      await chrome.windows.update(normalWin.id, { focused: true });
    }
  }

  // 在非无痕窗口中创建标签页（先确保焦点在普通窗口，再创建 tab）
  // 内置重试：当 Chrome 因用户拖拽标签页等原因锁定 tabs 操作时自动重试
  async function createTabInNormalWindow(url) {
    return withRetry(async () => {
      const allWindows = await chrome.windows.getAll({ populate: false });
      const normalWin = allWindows.find(w => !w.incognito);
      if (!normalWin) {
        // 如果没有普通窗口，直接创建（浏览器默认行为）
        return chrome.tabs.create({ url, active: true });
      }
      await chrome.windows.update(normalWin.id, { focused: true });
      return chrome.tabs.create({ windowId: normalWin.id, url, active: true });
    }, {
      maxAttempts: 3,
      delayMs: 1000,
      shouldRetry: (err) => /cannot be edited|dragging/i.test(err.message || ''),
      onRetry: (attempt, err) => {
        console.warn(`[team-auth] createTabInNormalWindow 第 ${attempt} 次失败（${err.message}��，1s 后重试...`);
      },
    });
  }

  // [CUSTOM] 清除 OpenAI/ChatGPT 相关 cookies（仅非无痕 store），用于完整流程模式每轮开始前
  const OPENAI_COOKIE_DOMAINS = [
    'chatgpt.com', 'chat.openai.com', 'openai.com',
    'auth.openai.com', 'auth0.openai.com', 'accounts.openai.com',
  ];

  async function clearOpenAiCookies() {
    if (!chrome.cookies?.getAll || !chrome.cookies?.remove) return 0;

    // 只收集非无痕 cookie store
    const stores = await chrome.cookies.getAllCookieStores();
    const nonIncognitoStoreIds = [];
    for (const store of stores) {
      if (store.id === '0') { nonIncognitoStoreIds.push('0'); continue; }
      let isIncognito = false;
      for (const tabId of (store.tabIds || [])) {
        try { const t = await chrome.tabs.get(tabId); if (t.incognito) { isIncognito = true; break; } } catch {}
      }
      if (!isIncognito) nonIncognitoStoreIds.push(store.id);
    }
    if (!nonIncognitoStoreIds.length) nonIncognitoStoreIds.push('0');

    let removed = 0;
    const seen = new Set();
    for (const storeId of nonIncognitoStoreIds) {
      const all = await chrome.cookies.getAll({ storeId });
      for (const c of all) {
        const domain = String(c.domain || '').replace(/^\.+/, '').toLowerCase();
        if (!OPENAI_COOKIE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) continue;
        const key = [storeId, c.domain, c.path, c.name, c.partitionKey ? JSON.stringify(c.partitionKey) : ''].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        const host = domain;
        const path = String(c.path || '/').startsWith('/') ? c.path : '/' + c.path;
        const details = { url: `https://${host}${path}`, name: c.name };
        if (c.storeId) details.storeId = c.storeId;
        if (c.partitionKey) details.partitionKey = c.partitionKey;
        try { if (await chrome.cookies.remove(details)) removed++; } catch {}
      }
    }
    return removed;
  }

  root.TeamAuthUtils = {
    escapeHtml, formatTime, showToast, sleep, withRetry,
    sendBgMessage, execInTab, waitForTabLoad, openOrReuseTab,
    openOrReuseTabInIncognito, ensureMembersTab,
    ensureFocusOnNormalWindow, createTabInNormalWindow,
    clearOpenAiCookies,
  };
})(window);
