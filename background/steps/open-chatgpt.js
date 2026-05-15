(function attachBackgroundStep1(root, factory) {
  root.MultiPageBackgroundStep1 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep1Module() {
  const STEP1_COOKIE_CLEAR_DOMAINS = [
    'chatgpt.com',
    'chat.openai.com',
    'openai.com',
    'auth.openai.com',
    'auth0.openai.com',
    'accounts.openai.com',
  ];
  const STEP1_COOKIE_CLEAR_ORIGINS = [
    'https://chatgpt.com',
    'https://chat.openai.com',
    'https://auth.openai.com',
    'https://auth0.openai.com',
    'https://accounts.openai.com',
    'https://openai.com',
  ];

  function normalizeCookieDomainForStep1(domain) {
    return String(domain || '').trim().replace(/^\.+/, '').toLowerCase();
  }

  function shouldClearStep1Cookie(cookie) {
    const domain = normalizeCookieDomainForStep1(cookie?.domain);
    if (!domain) return false;
    return STEP1_COOKIE_CLEAR_DOMAINS.some((target) => (
      domain === target || domain.endsWith(`.${target}`)
    ));
  }

  function buildStep1CookieRemovalUrl(cookie) {
    const host = normalizeCookieDomainForStep1(cookie?.domain);
    const rawPath = String(cookie?.path || '/');
    const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
    return `https://${host}${path}`;
  }

  function getStep1ErrorMessage(error) {
    return error?.message || String(error || '未知错误');
  }

  // [CUSTOM] 无痕窗口兼容：仅收集非无痕 cookie store，避免清除无痕窗口中的主账号登录态
  async function getStep1NonIncognitoStoreIds(chromeApi) {
    if (!chromeApi.cookies?.getAllCookieStores) return ['0'];
    const stores = await chromeApi.cookies.getAllCookieStores();
    const nonIncognitoIds = [];

    for (const store of stores) {
      const storeId = store?.id;
      if (!storeId) continue;

      // 默认 store "0" 始终是非无痕
      if (storeId === '0') {
        nonIncognitoIds.push(storeId);
        continue;
      }

      // 通过关联的 tab 判断窗口是否无痕
      const tabIds = store.tabIds || [];
      let isIncognito = false;
      for (const tabId of tabIds) {
        try {
          const tab = await chromeApi.tabs.get(tabId);
          if (tab.incognito) {
            isIncognito = true;
            break;
          }
        } catch {
          // tab 可能已关闭，忽略
        }
      }

      if (!isIncognito) {
        nonIncognitoIds.push(storeId);
      }
    }

    return nonIncognitoIds.length ? nonIncognitoIds : ['0'];
  }

  async function collectStep1Cookies(chromeApi) {
    if (!chromeApi.cookies?.getAll) {
      return [];
    }

    // [CUSTOM] 使用 getStep1NonIncognitoStoreIds 替换原始的 getAllCookieStores 遍历
    const nonIncognitoStoreIds = await getStep1NonIncognitoStoreIds(chromeApi);
    const cookies = [];
    const seen = new Set();

    for (const storeId of nonIncognitoStoreIds) { // [CUSTOM] 原始代码遍历 stores 对象
      const batch = await chromeApi.cookies.getAll({ storeId });
      for (const cookie of batch || []) {
        if (!shouldClearStep1Cookie(cookie)) continue;
        const key = [
          cookie.storeId || storeId || '',
          cookie.domain || '',
          cookie.path || '',
          cookie.name || '',
          cookie.partitionKey ? JSON.stringify(cookie.partitionKey) : '',
        ].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push(cookie);
      }
    }

    return cookies;
  }

  async function removeStep1Cookie(chromeApi, cookie) {
    const details = {
      url: buildStep1CookieRemovalUrl(cookie),
      name: cookie.name,
    };
    if (cookie.storeId) {
      details.storeId = cookie.storeId;
    }
    if (cookie.partitionKey) {
      details.partitionKey = cookie.partitionKey;
    }

    try {
      const result = await chromeApi.cookies.remove(details);
      return Boolean(result);
    } catch (error) {
      console.warn('[MultiPage:step1] remove cookie failed', {
        domain: cookie?.domain,
        name: cookie?.name,
        message: getStep1ErrorMessage(error),
      });
      return false;
    }
  }

  function createStep1Executor(deps = {}) {
    const {
      addLog,
      chrome: chromeApi = globalThis.chrome,
      completeStepFromBackground,
      getState,
      openSignupEntryTab,
      setState,
    } = deps;

    async function clearOpenAiCookiesBeforeStep1() {
      if (!chromeApi?.cookies?.getAll || !chromeApi.cookies?.remove) {
        await addLog('步骤 1：当前浏览器不支持 cookies API，跳过打开官网前 cookie 清理。', 'warn');
        return;
      }

      await addLog('步骤 1：打开 ChatGPT 官网前清理 ChatGPT / OpenAI cookies...', 'info');
      const cookies = await collectStep1Cookies(chromeApi);
      let removedCount = 0;
      for (const cookie of cookies) {
        if (await removeStep1Cookie(chromeApi, cookie)) {
          removedCount += 1;
        }
      }

      // [CUSTOM] 注意：不使用 browsingData.removeCookies 补扫，因为它无法区分无痕与非无痕，
      // 会清除无痕窗口中的主账号登录态。上面的逐 store 清理已覆盖非无痕 cookies。

      await addLog(`步骤 1：已清理 ${removedCount} 个 ChatGPT / OpenAI cookies。`, 'ok');

      // [CUSTOM] 清除 Service Worker、缓存、localStorage 和 IndexedDB，
      // 防止已登录用户的前端 SPA 缓存导致页面仍呈现已登录状态（找不到注册入口）。
      // 这些存储类型在无痕模式下有独立隔离，不会影响无痕窗口中的主账号。
      // 注意：这里故意不包含 cookies，cookies 已通过上面的逐 store 方式处理。
      if (chromeApi.browsingData?.remove) {
        try {
          await chromeApi.browsingData.remove(
            { origins: STEP1_COOKIE_CLEAR_ORIGINS },
            {
              serviceWorkers: true,
              cacheStorage: true,
              localStorage: true,
              indexedDB: true,
            }
          );
          await addLog('步骤 1：已清理 ChatGPT / OpenAI 浏览数据（SW/缓存/本地存储）。', 'ok');
        } catch (error) {
          await addLog(`步骤 1：浏览数据清理失败（${getStep1ErrorMessage(error)}），继续执行。`, 'warn');
        }
      }
    }

    async function executeStep1() {
      await clearOpenAiCookiesBeforeStep1();

      // [CUSTOM] 清空 tabRegistry 中的 signup-page 条目和 sourceLastUrls，
      // 确保 reuseOrCreateTab 不会复用上一轮失败后残留的旧 tab。
      // 如果旧 tab 仍停留在 chatgpt.com 且 URL 与目标相同，reuseOrCreateTab
      // 会直接激活旧 tab 而不刷新，导致已登录状态的页面被复用。
      if (typeof getState === 'function' && typeof setState === 'function') {
        try {
          const state = await getState();
          const registry = state?.tabRegistry || {};
          const lastUrls = state?.sourceLastUrls || {};
          if (registry['signup-page'] || lastUrls['signup-page']) {
            delete registry['signup-page'];
            delete lastUrls['signup-page'];
            await setState({ tabRegistry: registry, sourceLastUrls: lastUrls });
            await addLog('步骤 1：已清除旧的 signup-page tab 注册，将使用全新 tab。', 'info');
          }
        } catch (err) {
          await addLog(`步骤 1：清除 tab 注册失败（${getStep1ErrorMessage(err)}），继续执行。`, 'warn');
        }
      }

      await addLog('步骤 1：正在打开 ChatGPT 官网...');
      await openSignupEntryTab(1);
      await completeStepFromBackground(1, {});
    }

    return { executeStep1 };
  }

  return { createStep1Executor };
});
