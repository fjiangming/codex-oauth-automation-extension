(function attachBackgroundStep6(root, factory) {
  root.MultiPageBackgroundStep6 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep6Module() {
  const DEFAULT_REGISTRATION_SUCCESS_WAIT_MS = 20000;

  function createStep6Executor(deps = {}) {
    const {
      addLog = async () => {},
      completeStepFromBackground,
      registrationSuccessWaitMs = DEFAULT_REGISTRATION_SUCCESS_WAIT_MS,
      sleepWithStop = async (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))),
    } = deps;

    async function executeStep6() {
      const waitMs = Math.max(0, Math.floor(Number(registrationSuccessWaitMs) || 0));
      if (waitMs > 0) {
        await addLog(`步骤 6：等待 ${Math.round(waitMs / 1000)} 秒，确认注册成功并让页面稳定...`, 'info');
        await sleepWithStop(waitMs);
      }
      await addLog('步骤 6：注册成功等待完成，准备继续获取 OAuth 链接并登录。', 'ok');
      await completeStepFromBackground(6);
    }

    return { executeStep6 };
  }

  return { createStep6Executor };
});
