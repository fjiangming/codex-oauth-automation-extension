/**
 * workspace-auto-select.js
 *
 * 独立 content script —— 在 auth.openai.com 页面自动跳过 "Workspace 选择页"。
 *
 * 当 Team 账号通过 OAuth 登录后，页面可能弹出一个中间页让用户选择
 * 个人账户或 Team workspace。本脚本自动选择「个人帐户」选项，
 * 并点击页面上的「继续」按钮，使 OAuth 授权流程无阻塞地继续。
 *
 * 设计原则：
 *   - 完全自治，不依赖也不修改 signup-page.js / background.js
 *   - 通过 MutationObserver 持续监测 DOM 变化
 *   - 仅在页面文本匹配 workspace 选择特征且存在「继续」按钮时才介入
 *   - 优先选择「个人帐户」（而非默认的团队工作空间）
 */
(function workspaceAutoSelect() {
  'use strict';

  // ============================================================
  // 配置
  // ============================================================

  /** Workspace 选择页的文本特征（中/英/繁体双语） */
  const WS_TEXT_PATTERN = /[选選][择擇].*(?:工作空[间間]|workspace)|choose.*(?:workspace|account)|select.*(?:workspace|account)/i;

  /** 「继续」按钮的文本特征 */
  const CONTINUE_PATTERN = /^(?:继续|繼續|continue|下一步|next)$/i;

  /**
   * 需要排除的页面（不应介入）
   * 注意：不再排除 consent 页面，因为 workspace 选择页就在 consent 路径上。
   * 排除逻辑只过滤验证码页和手机号页。
   */
  const VERIFICATION_MARKER = /one-time|verification|验证码|verify.*email/i;
  const ADD_PHONE_MARKER = /add.*phone|添加.*手机|phone.*number/i;

  /** 「个人帐户」选项的文本特征（中/英双语，兼容「帐户」和「账户」） */
  const PERSONAL_ACCOUNT_PATTERN = /[个個]人(?:[帐賬帳][户戶]|account)|personal\s*account/i;

  /** 防抖：两次自动点击之间的最小间隔（ms） */
  const CLICK_COOLDOWN_MS = 5000;

  /** 最大自动点击次数，防止死循环 */
  const MAX_AUTO_CLICKS = 3;

  // ============================================================
  // 状态
  // ============================================================
  let lastClickTime = 0;
  let clickCount = 0;
  let observer = null;

  // ============================================================
  // 工具函数
  // ============================================================

  function log(msg) {
    console.log('[workspace-auto-select]', msg);
  }

  function getPageText() {
    return (document.body?.innerText || document.body?.textContent || '').trim();
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && parseFloat(style.opacity) > 0;
  }

  function getButtonText(el) {
    return (
      el.getAttribute('data-dd-action-name')
      || el.textContent
      || el.getAttribute('aria-label')
      || ''
    ).trim();
  }

  /**
   * 模拟真实用户点击（触发 React 合成事件）
   */
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // ============================================================
  // 核心逻辑
  // ============================================================

  function isWorkspaceSelectionPage() {
    const pageText = getPageText();

    // 必须匹配 workspace 选择特征文本
    if (!WS_TEXT_PATTERN.test(pageText)) return false;

    // 排除验证码页、手机号页
    if (VERIFICATION_MARKER.test(pageText)) return false;
    if (ADD_PHONE_MARKER.test(pageText)) return false;

    // 页面上必须存在 radio 选项组（workspace 选择页的核心特征）
    const radios = document.querySelectorAll('input[type="radio"][name="workspace_id"]');
    if (radios.length === 0) return false;

    // 页面上必须存在可见的「继续」按钮
    return Boolean(findContinueButton());
  }

  function findContinueButton() {
    const candidates = document.querySelectorAll('button, [role="button"], input[type="submit"]');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      if (CONTINUE_PATTERN.test(getButtonText(el))) {
        return el;
      }
    }
    return null;
  }

  /**
   * 查找并选择「个人帐户」radio 选项。
   * 返回 true 表示已选中或已切换，false 表示未找到。
   */
  function selectPersonalAccount() {
    const radios = document.querySelectorAll('input[type="radio"][name="workspace_id"]');
    if (radios.length === 0) return false;

    // 遍历所有 radio，找到其 label 文本包含「个人帐户/个人账户/Personal Account」的那个
    for (const radio of radios) {
      const label = radio.closest('label');
      if (!label) continue;

      const labelText = (label.textContent || '').trim();
      if (PERSONAL_ACCOUNT_PATTERN.test(labelText)) {
        if (radio.checked) {
          log('「个人帐户」已经是选中状态');
          return true;
        }
        // 点击 label 以切换 radio（更可靠，触发 React 事件）
        log('正在切换到「个人帐户」选项...');
        simulateClick(label);
        // 备用：直接设置 checked 并触发事件
        if (!radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event('input', { bubbles: true }));
          radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        log('已切换到「个人帐户」');
        return true;
      }
    }

    // 如果没找到「个人帐户」文本，尝试通过头像缩写（单字母/两字母缩写）来区分
    // 团队工作空间通常有建筑图标(svg)，个人帐户通常有字母缩写
    for (const radio of radios) {
      const label = radio.closest('label');
      if (!label) continue;

      // 检查是否包含 initialsContainer（个人帐户头像特征）
      const hasInitials = label.querySelector('[class*="initials"], [class*="Initials"]');
      if (hasInitials) {
        if (radio.checked) {
          log('通过头像特征识别：「个人帐户」已选中');
          return true;
        }
        log('通过头像特征识别，正在切换到「个人帐户」...');
        simulateClick(label);
        if (!radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event('input', { bubbles: true }));
          radio.dispatchEvent(new Event('change', { bubbles: true }));
        }
        log('已切换到「个人帐户」');
        return true;
      }
    }

    log('未能识别「个人帐户」选项，将保持当前选择');
    return false;
  }

  function tryAutoClick() {
    if (clickCount >= MAX_AUTO_CLICKS) return;
    if (Date.now() - lastClickTime < CLICK_COOLDOWN_MS) return;
    if (!isWorkspaceSelectionPage()) return;

    const btn = findContinueButton();
    if (!btn) return;

    log('检测到 Workspace 选择页面，准备自动处理...');

    // 先切换到「个人帐户」
    selectPersonalAccount();

    lastClickTime = Date.now();
    clickCount++;

    // 模拟人类延迟后点击「继续」
    setTimeout(() => {
      if (!isVisible(btn)) {
        log('按钮在延迟后已不可见，跳过点击');
        return;
      }
      // 再次确认个人帐户已选中
      selectPersonalAccount();
      simulateClick(btn);
      log('已自动点击「继续」按钮（第 ' + clickCount + ' 次）');
    }, 500 + Math.random() * 500);
  }

  // ============================================================
  // 启动观察者
  // ============================================================

  function startObserving() {
    // 初始检查
    tryAutoClick();

    // 监听 DOM 变化
    observer = new MutationObserver(() => {
      tryAutoClick();
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    log('已启动 Workspace 选择页自动处理（MutationObserver）');
  }

  // 页面就绪后启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  } else {
    startObserving();
  }
})();
