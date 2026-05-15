/* team-auth-steps.js — Team 操作步骤（邀请/邮件/接受/清理） */
(function (root) {
  'use strict';
  const U = root.TeamAuthUtils;

  // ============================================================
  // 步骤：邀请成员进团队
  // ============================================================
  async function inviteMemberToTeam(email, seatType, addLog) {
    const targetSeat = seatType || 'Codex';
    await addLog(`在无痕窗口中打开 Team 成员管理页面...（席位类型：${targetSeat}）`, 'info');
    const tabId = await U.openOrReuseTabInIncognito(
      'https://chatgpt.com/admin/members?tab=members',
      'https://chatgpt.com/admin/*'
    );
    // 等待 SPA 路由稳定，确保停留在 Members tab（ChatGPT 可能自动跳 invites）
    await U.ensureMembersTab(tabId);
    await U.sleep(500);

    await addLog('查找"邀请成员"按钮...', 'info');
    let clickedInvite = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      clickedInvite = await U.execInTab(tabId, () => {
        // 精确匹配：btn-primary 按钮且内含"邀请成员"文本
        const btns = [...document.querySelectorAll('button.btn-primary')];
        const btn = btns.find(b => b.textContent.includes('邀请成员') || b.textContent.includes('Invite'));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (clickedInvite) break;
      await addLog(`第 ${attempt}/3 次未找到"邀请成员"按钮，重试...`, 'warn');
      // 可能还没切到 members tab，再点一次"用户"
      await U.ensureMembersTab(tabId);
      await U.sleep(1500);
    }
    if (!clickedInvite) throw new Error('重试3次后仍未找到"邀请成员"按钮');
    await U.sleep(1500);

    await addLog(`输入邮箱：${email}`, 'info');
    const filledEmail = await U.execInTab(tabId, (em) => {
      const input = document.querySelector('input#email') ||
        document.querySelector('input[type="email"]') ||
        document.querySelector('input[placeholder*="email" i]') ||
        document.querySelector('input[placeholder*="邮箱"]');
      if (!input) return false;
      input.focus();
      input.value = em;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, [email]);
    if (!filledEmail) throw new Error('未找到邮箱输入框');
    await U.sleep(500);

    // 检查席位类型是否为目标类型，如果不是则切换
    await addLog(`检查席位类型（目标：${targetSeat}）...`, 'info');
    const needSwitch = await U.execInTab(tabId, (target) => {
      const combos = [...document.querySelectorAll('[role="combobox"]')];
      for (const c of combos) {
        const text = (c.textContent || '').trim();
        if (text === target) return false; // 已经是目标类型
      }
      return true; // 需要切换
    }, [targetSeat]);

    if (needSwitch) {
      await addLog(`席位类型不是 ${targetSeat}，正在切换...`, 'warn');

      let selected = false;
      for (let retry = 0; retry < 3 && !selected; retry++) {
        // 点击 combobox 打开下拉
        await U.execInTab(tabId, () => {
          const combos = [...document.querySelectorAll('[role="combobox"]')];
          const seatCombo = combos.find(c => {
            const text = (c.textContent || '').trim().toLowerCase();
            return text.includes('chatgpt') || text.includes('plus') || text.includes('codex')
              || text.includes('team') || text.includes('seat');
          }) || combos[combos.length - 1];
          if (seatCombo) seatCombo.click();
        });
        await U.sleep(1200);

        // 探测下拉面板中的元素并尝试选择目标席位类型
        const result = await U.execInTab(tabId, (target) => {
          // 广泛收集所有可能是下拉选项的元素
          const candidateSelectors = [
            '[role="option"]',
            '[role="listbox"] *',
            '[data-radix-collection-item]',
            '[data-radix-select-viewport] *',
            '[cmdk-item]',
            '[data-state="checked"], [data-state="unchecked"]',
            // Radix popover/select content portal
            '[data-radix-popper-content-wrapper] *',
            '[data-side]  *',
          ];

          // 合并所有候选元素（去重）
          const seen = new Set();
          const allCandidates = [];
          for (const sel of candidateSelectors) {
            try {
              document.querySelectorAll(sel).forEach(el => {
                if (!seen.has(el)) { seen.add(el); allCandidates.push(el); }
              });
            } catch (_) {}
          }

          // 调试：收集所有候选元素的文本
          const debugTexts = [];
          for (const el of allCandidates) {
            const text = (el.textContent || '').trim();
            if (text && text.length < 50 && !debugTexts.includes(text)) {
              debugTexts.push(text);
            }
          }

          // 策略1：精确匹配文本为目标席位类型的元素
          for (const el of allCandidates) {
            if ((el.textContent || '').trim() === target) {
              el.click();
              return { selected: true, method: 'exact', debugTexts };
            }
          }

          // 策略2：包含目标席位类型的元素（取最短文本的，避免误匹配父容器）
          const matchCandidates = allCandidates
            .filter(el => (el.textContent || '').trim().includes(target))
            .sort((a, b) => (a.textContent || '').trim().length - (b.textContent || '').trim().length);
          if (matchCandidates.length > 0) {
            matchCandidates[0].click();
            return { selected: true, method: 'contains', debugTexts };
          }

          return { selected: false, debugTexts };
        }, [targetSeat]);

        if (result?.selected) {
          selected = true;
          await addLog(`已选择 ${targetSeat} 席位类型（方式：${result.method}）`, 'ok');
        } else {
          const texts = (result?.debugTexts || []).join(', ');
          await addLog(`第 ${retry + 1}/3 次未找到 ${targetSeat} 选项，下拉中的文本：[${texts}]`, 'warn');
          // 点击其他区域关闭下拉，再重试
          await U.execInTab(tabId, () => {
            document.body.click();
          });
          await U.sleep(500);
        }
      }

      if (!selected) {
        await addLog(`多次尝试后仍未能选择 ${targetSeat} 席位，请手动检查`, 'warn');
      }
    } else {
      await addLog(`席位类型已是 ${targetSeat}`, 'info');
    }
    await U.sleep(300);

    await addLog('点击"发送邀请"...', 'info');
    const sentInvite = await U.execInTab(tabId, () => {
      const btns = [...document.querySelectorAll('button')];
      const btn = btns.find(b =>
        (b.textContent.includes('发送邀请') || b.textContent.includes('Send invite') || b.textContent.includes('Send Invite'))
        && !b.disabled
      );
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!sentInvite) throw new Error('未找到"发送邀请"按钮');
    await U.sleep(3000);
    await addLog('邀请已发送', 'ok');
  }

  // ============================================================
  // 步骤：获取邀请邮件（直接操控 QQ 邮箱 tab）
  // ============================================================
  async function fetchInvitationEmail(email, state, addLog) {
    await addLog('开始轮询邀请邮件...', 'info');
    return await pollInviteViaQQMailTab(email, addLog);
  }

  // 发件人和主题过滤关键词
  const INVITE_SENDER_FILTERS = ['openai', 'codex', 'chatgpt', 'team'];
  const INVITE_SUBJECT_FILTERS = ['codex', '入门指南', 'get started', 'invite', 'workspace', 'join'];

  // 邀请链接正则匹配模式
  const INVITE_URL_PATTERNS = [
    /href="(https:\/\/chatgpt\.com\/auth\/login\?inv[^"]+)"/i,
    /href="(https:\/\/chatgpt\.com[^"]*inv_ws[^"]+)"/i,
    /href="(https:\/\/chatgpt\.com\/invite\/[^"]+)"/i,
    /(https:\/\/chatgpt\.com\/auth\/login\?inv[^\s"'<>]+)/i,
    /(https:\/\/chatgpt\.com[^\s"'<>]*inv_ws[^\s"'<>]+)/i,
    /(https:\/\/chatgpt\.com\/invite\/[^\s"'<>]+)/i,
  ];

  function decodeHtmlEntities(str) {
    return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }

  function extractInviteUrl(text) {
    for (const pattern of INVITE_URL_PATTERNS) {
      const match = text.match(pattern);
      if (match?.[1]) return decodeHtmlEntities(match[1]);
    }
    return null;
  }

  /**
   * 找到或打开 QQ 邮箱 tab
   */
  async function findOrOpenQQMailTab(addLog) {
    const qqMailPatterns = ['https://wx.mail.qq.com/*', 'https://mail.qq.com/*'];
    for (const pattern of qqMailPatterns) {
      const tabs = await chrome.tabs.query({ url: pattern });
      if (tabs.length > 0) {
        await addLog(`复用已有 QQ 邮箱标签页（ID: ${tabs[0].id}）`, 'info');
        await chrome.tabs.update(tabs[0].id, { active: true });
        return tabs[0].id;
      }
    }
    // 没找到则新建
    await addLog('未找到已有 QQ 邮箱标签页，正在打开...', 'info');
    const tab = await U.createTabInNormalWindow('https://wx.mail.qq.com/');
    await U.withRetry(async () => {
      await U.waitForTabLoad(tab.id, 20000);
    }, { maxAttempts: 3, delayMs: 2000, onRetry: (a, e) => console.warn(`[team-auth] QQ邮箱加载第${a}次失败(${e.message})，重试...`) });
    await U.sleep(3000); // 等待邮件列表渲染
    return tab.id;
  }

  /**
   * 在 QQ 邮箱 tab 上刷新收件箱（F5 级别整页刷新 + 等待邮件列表 DOM 加载）
   */
  async function refreshQQMailInbox(tabId) {
    await U.execInTab(tabId, () => { location.reload(); });
    await U.waitForTabLoad(tabId, 15000);

    // 等待邮件列表 DOM 真正渲染完成（SPA 页面 tab.status=complete 时 AJAX 数据可能还没到）
    const maxWaitMs = 15000;
    const pollInterval = 800;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      const hasMailList = await U.execInTab(tabId, () => {
        return document.querySelectorAll('.mail-list-page-item[data-mailid]').length > 0;
      });
      if (hasMailList) return;
      await U.sleep(pollInterval);
    }
    // 超时不抛错，继续后续流程（可能收件箱确实是空的）
  }

  /**
   * 在 QQ 邮箱 tab 上搜索匹配的邀请邮件，返回 { found, mailId, sender, subject } 或 null
   */
  async function searchInviteMailInList(tabId, existingMailIds, useFallback) {
    return await U.execInTab(tabId, (args) => {
      const { senderFilters, subjectFilters, existingIds, fallback } = args;
      const existingSet = new Set(existingIds);
      const items = document.querySelectorAll('.mail-list-page-item[data-mailid]');

      for (const item of items) {
        const mailId = item.getAttribute('data-mailid');
        if (!fallback && existingSet.has(mailId)) continue;

        const sender = (item.querySelector('.cmp-account-nick')?.textContent || '').toLowerCase();
        const subject = (item.querySelector('.mail-subject')?.textContent || '').toLowerCase();

        const senderMatch = senderFilters.some(f => sender.includes(f));
        const subjectMatch = subjectFilters.some(f => subject.includes(f));

        if (senderMatch || subjectMatch) {
          return { found: true, mailId, sender, subject: subject.slice(0, 60) };
        }
      }
      return null;
    }, [{
      senderFilters: INVITE_SENDER_FILTERS,
      subjectFilters: INVITE_SUBJECT_FILTERS,
      existingIds: existingMailIds,
      fallback: useFallback,
    }]);
  }

  /**
   * 点击指定 mailId 的邮件条目，打开邮件详情
   */
  async function clickMailItem(tabId, mailId) {
    return await U.execInTab(tabId, (targetMailId) => {
      const item = document.querySelector(`.mail-list-page-item[data-mailid="${targetMailId}"]`);
      if (!item) return false;
      // 优先点击主题区域
      const subject = item.querySelector('.mail-subject') || item.querySelector('.mail-list-item-subject');
      if (subject) { subject.click(); return true; }
      // 兜底点击整个条目
      item.click();
      return true;
    }, [mailId]);
  }

  /**
   * 等待邮件详情加载完成，并从正文中提取邀请链接
   */
  async function waitAndExtractInviteUrl(tabId, addLog, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 15000);
    while (Date.now() < deadline) {
      const result = await U.execInTab(tabId, (patterns) => {
        // 检查邮件详情区域是否已加载
        // QQ 邮箱详情页常见容器
        const detailContainer =
          document.querySelector('.mail-detail-body') ||
          document.querySelector('.mail-content-body') ||
          document.querySelector('.readmail-content') ||
          document.querySelector('.qmbox') ||
          document.querySelector('#contentDiv') ||
          document.querySelector('.mail-detail');

        if (!detailContainer) return { loaded: false };

        // 获取详情区域完整 HTML 和文本
        const html = detailContainer.innerHTML || '';
        const text = detailContainer.innerText || detailContainer.textContent || '';

        // 也检查 iframe 内的内容（QQ 邮箱可能将正文放在 iframe 中）
        let iframeHtml = '';
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (iframeDoc?.body) {
              iframeHtml += iframeDoc.body.innerHTML || '';
            }
          } catch (_) { /* 跨域忽略 */ }
        }

        const fullHtml = html + iframeHtml;
        if (!fullHtml.trim() && !text.trim()) return { loaded: false };

        // 用正则提取邀请链接
        for (const patternStr of patterns) {
          const regex = new RegExp(patternStr, 'i');
          const match = fullHtml.match(regex) || text.match(regex);
          if (match?.[1]) return { loaded: true, inviteUrl: match[1] };
        }

        // 兜底：搜索所有 <a> 标签的 href
        const links = detailContainer.querySelectorAll('a[href]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (href.includes('chatgpt.com') && (href.includes('inv') || href.includes('invite'))) {
            return { loaded: true, inviteUrl: href };
          }
        }

        // iframe 内的链接也检查
        for (const iframe of iframes) {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
            if (!iframeDoc) continue;
            const iframeLinks = iframeDoc.querySelectorAll('a[href]');
            for (const link of iframeLinks) {
              const href = link.getAttribute('href') || '';
              if (href.includes('chatgpt.com') && (href.includes('inv') || href.includes('invite'))) {
                return { loaded: true, inviteUrl: href };
              }
            }
          } catch (_) { /* 跨域忽略 */ }
        }

        return { loaded: true, inviteUrl: null, htmlSnippet: fullHtml.slice(0, 500) };
      }, [INVITE_URL_PATTERNS.map(p => p.source)]);

      if (result?.inviteUrl) {
        return decodeHtmlEntities(result.inviteUrl);
      }
      if (result?.loaded) {
        await addLog('邮件详情已加载但未找到邀请链接，继续等待...', 'warn');
      }
      await U.sleep(1000);
    }
    return null;
  }

  /**
   * 检测当前是否在邮件详情页
   */
  async function isOnMailDetailView(tabId) {
    return await U.execInTab(tabId, () => {
      // 如果能找到含"返回"文本的按钮，说明在详情页
      const backBtns = [...document.querySelectorAll('.xmail-ui-btn')];
      const hasBack = backBtns.some(btn => {
        const text = btn.querySelector('.ui-btn-text');
        return text && text.textContent.trim() === '返回';
      });
      if (hasBack) return true;
      // 如果没有邮件列表但有详情内容，也认为在详情页
      const hasList = document.querySelectorAll('.mail-list-page-item[data-mailid]').length > 0;
      const hasDetail = document.querySelector('.mail-detail-body, .mail-content-body, .readmail-content, .qmbox, #contentDiv');
      return !hasList && !!hasDetail;
    });
  }

  /**
   * 点击 QQ 邮箱左上角"返回"按钮回到邮件列表
   */
  async function clickBackToMailList(tabId) {
    const clicked = await U.execInTab(tabId, () => {
      // 策略1：找到含"返回"文本的 xmail-ui-btn（精确匹配用户提供的 HTML 结构）
      const allBtns = [...document.querySelectorAll('.xmail-ui-btn')];
      const backBtn = allBtns.find(btn => {
        const textEl = btn.querySelector('.ui-btn-text');
        return textEl && textEl.textContent.trim() === '返回';
      });
      if (backBtn) { backBtn.click(); return true; }

      // 策略2：找 data-a11y="button" 且含"返回"文本
      const a11yBtns = [...document.querySelectorAll('[data-a11y="button"]')];
      const a11yBack = a11yBtns.find(btn => (btn.textContent || '').includes('返回'));
      if (a11yBack) { a11yBack.click(); return true; }

      return false;
    });
    if (clicked) await U.sleep(1500);
    return clicked;
  }

  /**
   * 确保当前在邮件列表视图，如果在详情页则先点返回
   */
  async function ensureOnMailListView(tabId, addLog) {
    const onDetail = await isOnMailDetailView(tabId);
    if (onDetail) {
      await addLog('检测到当前在邮件详情页，正在返回列表...', 'info');
      const backed = await clickBackToMailList(tabId);
      if (!backed) {
        await addLog('未找到返回按钮，尝试刷新收件箱...', 'warn');
        await refreshQQMailInbox(tabId);
      }
      await U.sleep(1000);
    }
  }

  /**
   * 从邮件详情返回邮件列表
   */
  async function returnToMailList(tabId) {
    await clickBackToMailList(tabId);
  }

  /**
   * 核心轮询逻辑：直接操控 QQ 邮箱 tab 轮询邀请邮件并提取链接
   * 每 RESEND_AFTER_ATTEMPTS 次轮询失败后自动重新发送邀请，最多重发 MAX_RESEND_COUNT 次
   */
  const RESEND_AFTER_ATTEMPTS = 10; // 每 10 次轮询失败触发一次重新发送
  const MAX_RESEND_COUNT = 3;       // 最多重新发送 3 次

  async function pollInviteViaQQMailTab(email, addLog) {
    const maxAttempts = RESEND_AFTER_ATTEMPTS * (MAX_RESEND_COUNT + 1); // 总计 40 次
    const intervalMs = 5000;
    const FALLBACK_AFTER = 5; // 5 轮后回退到全部邮件匹配
    let resendCount = 0;

    const tabId = await findOrOpenQQMailTab(addLog);
    await U.sleep(2000);

    // 先确保在列表视图（可能上次停留在详情页）
    await ensureOnMailListView(tabId, addLog);

    // 快照已有邮件 ID
    const existingMailIds = await U.execInTab(tabId, () => {
      const ids = [];
      document.querySelectorAll('.mail-list-page-item[data-mailid]').forEach(item => {
        ids.push(item.getAttribute('data-mailid'));
      });
      return ids;
    }) || [];
    await addLog(`已快照当前 ${existingMailIds.length} 封旧邮件`, 'info');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await addLog(`第 ${attempt}/${maxAttempts} 次轮询邀请邮件...`, 'info');

      // 每轮开始前确保在列表视图
      await ensureOnMailListView(tabId, addLog);

      // 刷新收件箱
      await refreshQQMailInbox(tabId);

      const useFallback = attempt > FALLBACK_AFTER;
      const matchResult = await searchInviteMailInList(tabId, existingMailIds, useFallback);

      if (matchResult?.found) {
        await addLog(`找到匹配邮件：${matchResult.subject}（发件人：${matchResult.sender}）`, 'info');

        // 点击打开邮件详情
        const clicked = await clickMailItem(tabId, matchResult.mailId);
        if (!clicked) {
          await addLog('点击邮件条目失败，继续下轮尝试...', 'warn');
          await U.sleep(intervalMs);
          continue;
        }
        await U.sleep(2000); // 等待详情页加载

        // 提取邀请链接
        const inviteUrl = await waitAndExtractInviteUrl(tabId, addLog, 15000);
        if (inviteUrl) {
          await addLog(`已从邮件详情中提取邀请链接`, 'ok');
          // 返回邮件列表（为后续操作留好状态）
          await returnToMailList(tabId);
          return inviteUrl;
        }

        await addLog('未能从邮件详情中提取到邀请链接，尝试返回列表继续...', 'warn');
        await returnToMailList(tabId);
      }

      if (attempt === FALLBACK_AFTER + 1) {
        await addLog(`连续 ${FALLBACK_AFTER} 次未发现新邮件，开始回退到全部匹配`, 'warn');
      }

      // 每 RESEND_AFTER_ATTEMPTS 次失败后触发重新发送邀请
      if (attempt % RESEND_AFTER_ATTEMPTS === 0 && resendCount < MAX_RESEND_COUNT) {
        resendCount++;
        await addLog(`连续 ${RESEND_AFTER_ATTEMPTS} 次未获取到邀请邮件，尝试第 ${resendCount}/${MAX_RESEND_COUNT} 次重新发送邀请...`, 'warn');
        try {
          await resendInvitation(email, addLog);
          await addLog(`重新发送邀请成功（第 ${resendCount} 次），继续轮询...`, 'ok');
        } catch (resendErr) {
          await addLog(`重新发送邀请失败：${resendErr.message}，继续轮询...`, 'warn');
        }
      }

      if (attempt < maxAttempts) {
        await U.sleep(intervalMs);
      }
    }

    throw new Error(`轮询 ${maxAttempts} 次且重发 ${resendCount} 次后仍未获取到邀请邮件，请手动检查。`);
  }

  // ============================================================
  // 重新发送邀请：在无痕窗口 admin 页面操作
  // ============================================================
  /**
   * 在已登录主账号的无痕窗口中打开待处理邀请页面，
   * 找到目标邮箱对应的行，点击省略号菜单中的"重新发送邀请"按钮。
   */
  async function resendInvitation(email, addLog) {
    await addLog(`在无痕窗口中打开待处理邀请页面，准备重新发送邀请给 ${email}...`, 'info');
    const tabId = await U.openOrReuseTabInIncognito(
      'https://chatgpt.com/admin/members?tab=invites',
      'https://chatgpt.com/admin/*'
    );

    // 确保停留在 Invites tab（页面可能自动跳转到其他 tab）
    await ensureInvitesTab(tabId);
    await U.sleep(1000);

    // 等待待处理邀请表格渲染
    const rowCount = await waitForInvitesTableReady(tabId, 12000);
    if (rowCount === 0) {
      throw new Error('待处理邀请列表表格未渲染（12秒超时）');
    }
    await addLog(`待处理邀请列表已加载（${rowCount} 行）`, 'info');

    // 查找目标邮箱行并点击省略号菜单按钮
    const findResult = await findAndClickInviteMenu(tabId, email);
    await addLog(`查找邀请行结果：${findResult?.debug || '无返回'}`, 'info');
    if (!findResult?.found) {
      throw new Error(`未在待处理邀请列表中找到 ${email}`);
    }

    // 等待弹出菜单渲染，点击"重新发送邀请"
    let resent = false;
    for (let i = 0; i < 12; i++) {
      await U.sleep(500);
      resent = await U.execInTab(tabId, () => {
        const items = [...document.querySelectorAll(
          '[role="menuitem"], [role="menu"] button, [data-radix-collection-item]'
        )];
        const allTexts = items.map(el => (el.textContent || '').trim()).filter(Boolean);
        const resendBtn = items.find(el => {
          const text = (el.textContent || '').trim();
          return /重新发送邀请|Resend\s*invite/i.test(text);
        });
        if (resendBtn) {
          // Radix MenuItem 监听 pointerdown
          const opts = { bubbles: true, cancelable: true, view: window };
          resendBtn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
          resendBtn.dispatchEvent(new MouseEvent('mousedown', opts));
          resendBtn.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
          resendBtn.dispatchEvent(new MouseEvent('mouseup', opts));
          resendBtn.dispatchEvent(new MouseEvent('click', opts));
          return { clicked: true, allTexts };
        }
        return { clicked: false, allTexts };
      });
      if (resent?.clicked) {
        await addLog(`已点击"重新发送邀请"（菜单项：${resent.allTexts?.join(', ')})`, 'ok');
        break;
      }
    }
    if (!resent?.clicked) {
      const menuTexts = resent?.allTexts?.join(', ') || '无菜单项';
      // 关闭可能残留的菜单
      await U.execInTab(tabId, () => { document.body.click(); });
      throw new Error(`未找到"重新发送邀请"菜单项（可见菜单：${menuTexts}）`);
    }

    await U.sleep(2000);
    await addLog(`已重新发送邀请给 ${email}`, 'ok');
  }

  /**
   * 确保 admin 页面停留在 Invites tab
   */
  async function ensureInvitesTab(tabId) {
    await U.sleep(1500);
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) {
      const tab = await chrome.tabs.get(tabId);
      const currentUrl = tab.url || '';
      if (currentUrl.includes('tab=invites')) return;

      // 点击"邀请"按钮切换到邀请列表
      const clicked = await U.execInTab(tabId, () => {
        const btns = [...document.querySelectorAll('button')];
        const btn = btns.find(el => el.textContent.trim() === '邀请' || el.textContent.trim() === 'Invites');
        if (btn) { btn.click(); return true; }
        return false;
      });

      if (clicked) {
        await U.sleep(1000);
        continue;
      }

      // 按钮未找到，强制导航
      await U.withRetry(async () => {
        await chrome.tabs.update(tabId, { url: 'https://chatgpt.com/admin/members?tab=invites' });
        await U.waitForTabLoad(tabId, 20000);
      }, {
        maxAttempts: 3,
        delayMs: 2000,
        onRetry: (attempt, err) => {
          console.warn(`[team-auth] ensureInvitesTab 导航第 ${attempt} 次失败（${err.message}），重试...`);
        },
      });
      await U.sleep(1500);
    }
  }

  /**
   * 等待待处理邀请表格渲染完成
   */
  async function waitForInvitesTableReady(tabId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 10000);
    while (Date.now() < deadline) {
      const rowCount = await U.execInTab(tabId, () => {
        return document.querySelectorAll('table tbody tr').length;
      });
      if (rowCount > 0) return rowCount;
      await U.sleep(500);
    }
    return 0;
  }

  /**
   * 在待处理邀请列表中根据邮箱查找对应行，并点击省略号操作按钮
   */
  async function findAndClickInviteMenu(tabId, email) {
    return await U.execInTab(tabId, (args) => {
      const { targetEmail } = args;
      const rows = [...document.querySelectorAll('table tbody tr')];
      const debugInfo = [];
      debugInfo.push(`共 ${rows.length} 行`);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;

        // 第一列是邮箱列
        const emailText = (cells[0]?.textContent || '').trim();
        const emailMatch = emailText.toLowerCase().includes(targetEmail.toLowerCase());
        if (!emailMatch) continue;

        debugInfo.push(`行${i}: 邮箱匹配✓ "${emailText}"`);

        // 定位最后一列的省略号菜单按钮
        const lastCell = cells[cells.length - 1];
        const menuBtn = lastCell?.querySelector('button[aria-haspopup="menu"]')
          || lastCell?.querySelector('button');

        if (!menuBtn) {
          debugInfo.push(`行${i}: 未找到操作按钮`);
          continue;
        }

        debugInfo.push(`行${i}: 点击操作按钮(id=${menuBtn.id})`);
        // Radix UI 监听 pointerdown，模拟完整指针事件序列
        const opts = { bubbles: true, cancelable: true, view: window };
        menuBtn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
        menuBtn.dispatchEvent(new MouseEvent('mousedown', opts));
        menuBtn.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
        menuBtn.dispatchEvent(new MouseEvent('mouseup', opts));
        menuBtn.dispatchEvent(new MouseEvent('click', opts));
        return { found: true, debug: debugInfo.join('; ') };
      }

      return { found: false, debug: debugInfo.join('; ') };
    }, [{ targetEmail: email }]);
  }

  // ============================================================
  // 步骤：接受 Codex 邀请
  // ============================================================
  async function acceptCodexInvitation(inviteUrl, addLog) {
    await addLog('打开邀请链接...', 'info');
    let finalUrl = inviteUrl;

    // 处理 QQ 邮箱安全跳转
    if (finalUrl.includes('xmspamcheck') || finalUrl.includes('xmsafejump')) {
      await addLog('检测到 QQ 邮箱安全拦截，尝试绕过...', 'warn');
      const safeTab = await U.createTabInNormalWindow(finalUrl);
      await U.withRetry(async () => {
        await U.waitForTabLoad(safeTab.id, 15000);
      }, { maxAttempts: 3, delayMs: 2000, onRetry: (a, e) => console.warn(`[team-auth] 安全跳转页加载第${a}次失败(${e.message})，重试...`) });
      await U.sleep(1500);
      const bypassed = await U.execInTab(safeTab.id, () => {
        const btn = document.getElementById('accessBtn') ||
          document.querySelector('[id*="access"]') ||
          [...document.querySelectorAll('a, button')].find(e => e.textContent.includes('继续访问'));
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (bypassed) {
        await U.sleep(3000);
        const tab = await chrome.tabs.get(safeTab.id);
        finalUrl = tab.url || finalUrl;
      }
      await chrome.tabs.remove(safeTab.id).catch(() => {});
    }

    // 打开最终邀请链接
    const tab = await U.createTabInNormalWindow(finalUrl);
    await U.withRetry(async () => {
      await U.waitForTabLoad(tab.id, 20000);
    }, { maxAttempts: 3, delayMs: 2000, onRetry: (a, e) => console.warn(`[team-auth] 邀请链接加载第${a}次失败(${e.message})，重试...`) });
    await U.sleep(3000);

    // 检查是否有"Get started"或"开始使用"按钮
    await U.execInTab(tab.id, () => {
      const btns = [...document.querySelectorAll('a, button')];
      const btn = btns.find(b =>
        b.textContent.includes('Get started') ||
        b.textContent.includes('开始使用') ||
        b.textContent.includes('Accept')
      );
      if (btn) btn.click();
    });
    await U.sleep(2000);
    await chrome.tabs.remove(tab.id).catch(() => {});
    await addLog('Codex 邀请已接受', 'ok');
  }

  // ============================================================
  // 步骤：清理团队子账号
  // ============================================================
  /**
   * 等待成员列表表格渲染完成（SPA 异步加载可能导致表格暂时为空）
   * @returns {number} 表格行数
   */
  async function waitForMemberTableReady(tabId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 10000);
    let lastReadyCount = 0;
    while (Date.now() < deadline) {
      const result = await U.execInTab(tabId, () => {
        const rows = document.querySelectorAll('table tbody tr');
        let readyRows = 0;
        for (const row of rows) {
          // 只有包含至少 2 个 td（有实际数据列）的行才算"就绪"
          if (row.querySelectorAll('td').length >= 2) readyRows++;
        }
        return { total: rows.length, ready: readyRows };
      });
      if (result?.ready > 0) {
        // 连续两次检测到相同数量的就绪行，认为渲染稳定
        if (result.ready === lastReadyCount) return result.ready;
        lastReadyCount = result.ready;
      }
      await U.sleep(500);
    }
    return 0; // 超时仍无就绪行
  }

  /**
   * 在成员列表中根据邮箱查找成员行，并点击操作按钮
   * @returns {{ found: boolean, debug: string }}
   */
  async function findAndClickMemberMenu(tabId, email) {
    return await U.execInTab(tabId, (args) => {
      const { targetEmail } = args;
      const rows = [...document.querySelectorAll('table tbody tr')];
      const debugInfo = [];
      debugInfo.push(`共 ${rows.length} 行`);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const cells = row.querySelectorAll('td');
        // 至少需要 2 列（邮箱列 + 操作列）才视为有效行
        if (cells.length < 2) {
          debugInfo.push(`行${i}: ${cells.length}列，跳过(不足2列)`);
          continue;
        }

        // 提取各列文本（安全访问，列数可能因 UI 版本不同而变化）
        const nameEmailText = (cells[0]?.textContent || '').trim();
        const roleText = cells.length > 1 ? (cells[1]?.textContent || '').trim() : '';

        // 检查邮箱匹配
        const emailMatch = nameEmailText.toLowerCase().includes(targetEmail.toLowerCase());
        if (!emailMatch) continue;

        debugInfo.push(`行${i}: 邮箱匹配OK ${cells.length}列 角色="${roleText}"`);

        // 跳过所有者（不能移除自己）
        if (/所有者|Owner/i.test(roleText)) {
          debugInfo.push(`行${i}: 是所有者，跳过`);
          continue;
        }

        // 定位操作按钮（最后一列的省略号菜单按钮）
        const lastCell = cells[cells.length - 1];
        const menuBtn = lastCell?.querySelector('button[aria-haspopup="menu"]')
          || lastCell?.querySelector('button');

        if (!menuBtn) {
          debugInfo.push(`行${i}: 未找到操作按钮`);
          continue;
        }

        debugInfo.push(`行${i}: 点击操作按钮(id=${menuBtn.id})`);
        // Radix UI 监听 pointerdown 而非 click，必须模拟完整指针事件序列
        const opts = { bubbles: true, cancelable: true, view: window };
        menuBtn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
        menuBtn.dispatchEvent(new MouseEvent('mousedown', opts));
        menuBtn.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
        menuBtn.dispatchEvent(new MouseEvent('mouseup', opts));
        menuBtn.dispatchEvent(new MouseEvent('click', opts));
        return { found: true, debug: debugInfo.join('; ') };
      }

      return { found: false, debug: debugInfo.join('; ') };
    }, [{ targetEmail: email }]);
  }

  async function removeMemberFromTeam(email, addLog) {
    await addLog('在无痕窗口中打开 Team 成员管理页面进行清理...', 'info');
    const tabId = await U.openOrReuseTabInIncognito(
      'https://chatgpt.com/admin/members?tab=members',
      'https://chatgpt.com/admin/*'
    );

    const MAX_REMOVE_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_REMOVE_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await addLog(`第 ${attempt}/${MAX_REMOVE_ATTEMPTS} 次重试移除 ${email}...`, 'warn');
        await U.execInTab(tabId, () => { location.reload(); });
        await U.waitForTabLoad(tabId, 15000);
      }

      // 确保停留在 Members tab
      await U.ensureMembersTab(tabId);
      await U.sleep(500);

      // 0. 等待成员列表表格渲染完成（验证行中有实际 td 单元格，防止骨架行误判）
      const rowCount = await waitForMemberTableReady(tabId, 12000);
      if (rowCount === 0) {
        await addLog(`第 ${attempt} 次：成员列表表格未渲染（12秒超时），${attempt < MAX_REMOVE_ATTEMPTS ? '将重试' : '放弃'}`, 'warn');
        continue;
      }
      await addLog(`成员列表已加载（${rowCount} 行就绪）`, 'info');
      // 额外等待 React hydration 稳定，避免 td 单元格尚未完全渲染
      await U.sleep(1000);

      // 1. 根据邮箱查找成员行，点击操作菜单
      await addLog(`查找成员：${email}（仅按邮箱匹配）`, 'info');
      const findResult = await findAndClickMemberMenu(tabId, email);
      await addLog(`查找结果：${findResult?.debug || '无返回'}`, 'info');

      if (!findResult?.found) {
        // 表格有行但找不到该邮箱 → 确实不存在
        await addLog(`未在成员列表中找到 ${email}，已被移除`, 'ok');
        return;
      }

      // 2. 等待弹出菜单渲染，点击"移除成员"
      let removed = false;
      for (let i = 0; i < 12; i++) {
        await U.sleep(500);
        removed = await U.execInTab(tabId, () => {
          const items = [...document.querySelectorAll(
            '[role="menuitem"], [role="menu"] button, [data-radix-collection-item]'
          )];
          // 收集所有菜单项文本用于调试
          const allTexts = items.map(el => (el.textContent || '').trim()).filter(Boolean);
          const removeBtn = items.find(el => {
            const text = (el.textContent || '').trim();
            return /移除成员|移除|Remove\s*member|Remove/i.test(text);
          });
          if (removeBtn) {
            // Radix MenuItem 监听 pointerdown
            const opts = { bubbles: true, cancelable: true, view: window };
            removeBtn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
            removeBtn.dispatchEvent(new MouseEvent('mousedown', opts));
            removeBtn.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
            removeBtn.dispatchEvent(new MouseEvent('mouseup', opts));
            removeBtn.dispatchEvent(new MouseEvent('click', opts));
            return { clicked: true, allTexts };
          }
          return { clicked: false, allTexts };
        });
        if (removed?.clicked) {
          await addLog(`已点击"移除成员"（菜单项：${removed.allTexts?.join(', ')})`, 'info');
          break;
        }
      }
      if (!removed?.clicked) {
        const menuTexts = removed?.allTexts?.join(', ') || '无菜单项';
        await addLog(`第 ${attempt} 次未找到"移除成员"菜单项（可见菜单：${menuTexts}），${attempt < MAX_REMOVE_ATTEMPTS ? '将重试' : '放弃'}`, 'warn');
        await U.execInTab(tabId, () => { document.body.click(); });
        await U.sleep(500);
        continue;
      }
      await U.sleep(1500);

      // 3. 确认移除（等待确认弹窗渲染）
      let confirmed = false;
      for (let i = 0; i < 12; i++) {
        await U.sleep(500);
        confirmed = await U.execInTab(tabId, () => {
          // 搜索所有可能的弹窗容器
          const containers = [
            ...document.querySelectorAll('[role="dialog"]'),
            ...document.querySelectorAll('[role="alertdialog"]'),
            ...document.querySelectorAll('[data-radix-portal]'),
          ];
          // 收集调试信息
          const allBtnTexts = [];
          for (const container of containers) {
            const btns = [...container.querySelectorAll('button')];
            for (const b of btns) {
              allBtnTexts.push((b.textContent || '').trim());
            }
            const confirmBtn = btns.find(b => {
              const text = (b.textContent || '').trim();
              return /^(确认移除|确认|删除|移除成员|Remove\s*member|Remove|Delete|Confirm)$/i.test(text) && !b.disabled;
            });
            if (confirmBtn) {
              const opts = { bubbles: true, cancelable: true, view: window };
              confirmBtn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1 }));
              confirmBtn.dispatchEvent(new MouseEvent('mousedown', opts));
              confirmBtn.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1 }));
              confirmBtn.dispatchEvent(new MouseEvent('mouseup', opts));
              confirmBtn.dispatchEvent(new MouseEvent('click', opts));
              return { clicked: true, allBtnTexts };
            }
          }
          // 兜底：btn-danger / btn-warning
          const dangerBtns = [...document.querySelectorAll('button.btn-danger, button.btn-warning')];
          for (const b of dangerBtns) { allBtnTexts.push('(danger)' + (b.textContent || '').trim()); }
          const fallback = dangerBtns.find(b => {
            const text = (b.textContent || '').trim();
            return /移除|Remove|确认|Confirm|删除|Delete/i.test(text) && !b.disabled;
          });
          if (fallback) {
            const opts2 = { bubbles: true, cancelable: true, view: window };
            fallback.dispatchEvent(new PointerEvent('pointerdown', { ...opts2, pointerId: 1 }));
            fallback.dispatchEvent(new MouseEvent('mousedown', opts2));
            fallback.dispatchEvent(new PointerEvent('pointerup', { ...opts2, pointerId: 1 }));
            fallback.dispatchEvent(new MouseEvent('mouseup', opts2));
            fallback.dispatchEvent(new MouseEvent('click', opts2));
            return { clicked: true, allBtnTexts };
          }
          return { clicked: false, allBtnTexts };
        });
        if (confirmed?.clicked) {
          await addLog(`已点击确认按钮（弹窗按钮：${confirmed.allBtnTexts?.join(', ')})`, 'info');
          break;
        }
      }
      if (!confirmed?.clicked) {
        const btnTexts = confirmed?.allBtnTexts?.join(', ') || '无按钮';
        await addLog(`第 ${attempt} 次未能点击确认按钮（可见按钮：${btnTexts}），${attempt < MAX_REMOVE_ATTEMPTS ? '将重试' : '放弃'}`, 'warn');
        await U.execInTab(tabId, () => {
          const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
          document.dispatchEvent(esc);
        });
        await U.sleep(500);
        continue;
      }
      await U.sleep(3000);

      // 4. 刷新页面验证成员是否真正被移除
      await U.execInTab(tabId, () => { location.reload(); });
      await U.waitForTabLoad(tabId, 15000);
      await U.sleep(1000);
      // 等待表格重新渲染
      const verifyRowCount = await waitForMemberTableReady(tabId, 12000);
      if (verifyRowCount === 0) {
        await addLog(`验证阶段：表格未渲染（${verifyRowCount} 行），无法确认移除结果，${attempt < MAX_REMOVE_ATTEMPTS ? '将重试' : '放弃'}`, 'warn');
        continue;
      }
      // 额外等待渲染稳定
      await U.sleep(1000);

      const stillExists = await U.execInTab(tabId, (args) => {
        const { targetEmail } = args;
        const rows = [...document.querySelectorAll('table tbody tr')];
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length < 2) continue;
          const text = (cells[0]?.textContent || '').toLowerCase();
          if (text.includes(targetEmail.toLowerCase())) {
            return true;
          }
        }
        return false;
      }, [{ targetEmail: email }]);

      if (!stillExists) {
        await addLog(`已确认 ${email} 已从团队中移除`, 'ok');
        return;
      }

      await addLog(`第 ${attempt} 次移除后 ${email} 仍在列表中，${attempt < MAX_REMOVE_ATTEMPTS ? '将重试' : ''}`, 'warn');
    }

    throw new Error(`尝试 ${MAX_REMOVE_ATTEMPTS} 次后仍未能移除 ${email}，请手动检查`);
  }

  root.TeamAuthSteps = {
    inviteMemberToTeam,
    fetchInvitationEmail,
    acceptCodexInvitation,
    removeMemberFromTeam,
    resendInvitation,
  };
})(window);
