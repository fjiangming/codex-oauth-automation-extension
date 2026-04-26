(function attachBackgroundPlusCheckoutCreate(root, factory) {
  root.MultiPageBackgroundPlusCheckoutCreate = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPlusCheckoutCreateModule() {
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';
  const PLUS_CHECKOUT_ENTRY_URL = 'https://chatgpt.com/';
  const PLUS_CHECKOUT_INJECT_FILES = ['content/utils.js', 'content/plus-checkout.js'];

  function createPlusCheckoutCreateExecutor(deps = {}) {
    const {
      addLog,
      chrome,
      completeStepFromBackground,
      ensureContentScriptReadyOnTabUntilStopped,
      reuseOrCreateTab,
      sendTabMessageUntilStopped,
      setState,
      sleepWithStop,
      waitForTabCompleteUntilStopped,
    } = deps;

    async function executePlusCheckoutCreate() {
      await addLog('步骤 6：正在打开 ChatGPT 会话页，准备创建 Plus Checkout...', 'info');
      const tabId = await reuseOrCreateTab(PLUS_CHECKOUT_SOURCE, PLUS_CHECKOUT_ENTRY_URL, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        reloadIfSameUrl: false,
      });

      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: '步骤 6：ChatGPT 页面仍在加载，等待 Plus Checkout 脚本就绪...',
      });

      const result = await sendTabMessageUntilStopped(tabId, PLUS_CHECKOUT_SOURCE, {
        type: 'CREATE_PLUS_CHECKOUT',
        source: 'background',
        payload: {},
      });

      if (result?.error) {
        throw new Error(result.error);
      }
      if (!result?.checkoutUrl) {
        throw new Error('步骤 6：Plus Checkout 创建后未返回支付链接。');
      }

      await addLog('步骤 6：Plus Checkout 已创建，正在打开支付页面...', 'ok');
      await chrome.tabs.update(tabId, { url: result.checkoutUrl, active: true });
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);
      await ensureContentScriptReadyOnTabUntilStopped(PLUS_CHECKOUT_SOURCE, tabId, {
        inject: PLUS_CHECKOUT_INJECT_FILES,
        injectSource: PLUS_CHECKOUT_SOURCE,
        logMessage: '步骤 6：Checkout 页面仍在加载，等待页面脚本就绪...',
      });

      await setState({
        plusCheckoutTabId: tabId,
        plusCheckoutUrl: result.checkoutUrl,
        plusCheckoutCountry: result.country || 'DE',
        plusCheckoutCurrency: result.currency || 'EUR',
      });

      await addLog('步骤 6：Plus Checkout 页面已就绪，准备继续下一步。', 'info');

      await completeStepFromBackground(6, {
        plusCheckoutCountry: result.country || 'DE',
        plusCheckoutCurrency: result.currency || 'EUR',
      });
    }

    return {
      executePlusCheckoutCreate,
    };
  }

  return {
    createPlusCheckoutCreateExecutor,
  };
});
