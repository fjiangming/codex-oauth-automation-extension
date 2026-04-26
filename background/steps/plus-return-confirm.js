(function attachBackgroundPlusReturnConfirm(root, factory) {
  root.MultiPageBackgroundPlusReturnConfirm = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundPlusReturnConfirmModule() {
  const PAYPAL_SOURCE = 'paypal-flow';
  const PLUS_CHECKOUT_SOURCE = 'plus-checkout';

  function createPlusReturnConfirmExecutor(deps = {}) {
    const {
      addLog,
      completeStepFromBackground,
      getTabId,
      isTabAlive,
      setState,
      sleepWithStop,
      waitForTabCompleteUntilStopped,
      waitForTabUrlMatchUntilStopped,
    } = deps;

    async function resolveReturnTabId(state = {}) {
      const paypalTabId = await getTabId(PAYPAL_SOURCE);
      if (paypalTabId && await isTabAlive(PAYPAL_SOURCE)) {
        return paypalTabId;
      }
      const checkoutTabId = await getTabId(PLUS_CHECKOUT_SOURCE);
      if (checkoutTabId) {
        return checkoutTabId;
      }
      const storedTabId = Number(state.plusCheckoutTabId) || 0;
      if (storedTabId) {
        return storedTabId;
      }
      throw new Error('步骤 9：未找到 Plus / PayPal 标签页，无法确认订阅回跳。');
    }

    function isReturnUrl(url = '') {
      return /https:\/\/(?:chatgpt\.com|chat\.openai\.com|openai\.com)\//i.test(String(url || ''))
        && !/paypal\./i.test(String(url || ''));
    }

    async function executePlusReturnConfirm(state = {}) {
      const tabId = await resolveReturnTabId(state);
      await addLog('步骤 9：正在等待 PayPal 授权后回跳到 ChatGPT / OpenAI 页面...', 'info');
      const tab = await waitForTabUrlMatchUntilStopped(tabId, isReturnUrl);
      await waitForTabCompleteUntilStopped(tabId);
      await sleepWithStop(1000);

      await setState({
        plusCheckoutTabId: tabId,
        plusReturnUrl: tab?.url || '',
      });
      await completeStepFromBackground(9, {
        plusReturnUrl: tab?.url || '',
      });
    }

    return {
      executePlusReturnConfirm,
    };
  }

  return {
    createPlusReturnConfirmExecutor,
  };
});
