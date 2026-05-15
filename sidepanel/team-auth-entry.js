/* team-auth-entry.js — Sidepanel 入口（仅此文件负责注入按钮，零侵入） */
(function injectTeamAuthEntryButton() {
  'use strict';

  // 目标锚点：在「贡献/使用教程」按钮后面插入
  const anchor = document.getElementById('btn-contribution-mode');
  if (!anchor) return;

  const btn = document.createElement('button');
  btn.id = 'btn-team-auth';
  btn.className = 'btn btn-outline btn-sm';
  btn.type = 'button';
  btn.title = '打开 Team 自定义注册认证页面';
  btn.textContent = '自定义认证';

  anchor.insertAdjacentElement('afterend', btn);

  btn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/team-auth-addon.html') });
  });
})();
