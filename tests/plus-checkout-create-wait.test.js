const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/create-plus-checkout.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundPlusCheckoutCreate;`)(globalScope);

test('Plus checkout create does not wait 20 seconds after opening checkout page', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => {
      events.push({ type: 'log', message, level });
    },
    chrome: {
      tabs: {
        create: async (payload) => {
          events.push({ type: 'tab-create', payload });
          return { id: 42 };
        },
        update: async (tabId, payload) => {
          events.push({ type: 'tab-update', tabId, payload });
        },
      },
    },
    completeStepFromBackground: async (step, payload) => {
      events.push({ type: 'complete', step, payload });
    },
    ensureContentScriptReadyOnTabUntilStopped: async () => {
      events.push({ type: 'ready' });
    },
    registerTab: async (source, tabId) => {
      events.push({ type: 'register', source, tabId });
    },
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      events.push({ type: 'tab-message', tabId, source, message });
      return {
        checkoutUrl: 'https://checkout.stripe.com/c/pay/session',
        country: 'US',
        currency: 'USD',
      };
    },
    setState: async (payload) => {
      events.push({ type: 'set-state', payload });
    },
    sleepWithStop: async (ms) => {
      events.push({ type: 'sleep', ms });
    },
    waitForTabCompleteUntilStopped: async () => {
      events.push({ type: 'tab-complete' });
    },
  });

  await executor.executePlusCheckoutCreate();

  assert.deepEqual(
    events.find((event) => event.type === 'tab-create'),
    { type: 'tab-create', payload: { url: 'https://chatgpt.com/', active: true } }
  );
  assert.deepEqual(
    events.find((event) => event.type === 'register'),
    { type: 'register', source: 'plus-checkout', tabId: 42 }
  );

  const sleepEvents = events.filter((event) => event.type === 'sleep');
  assert.deepStrictEqual(sleepEvents.map((event) => event.ms), [1000, 1000]);
  assert.deepStrictEqual(
    events.find((event) => event.type === 'tab-message')?.message?.payload,
    { paymentMethod: 'paypal' }
  );

  const completeIndex = events.findIndex((event) => event.type === 'complete');
  const readyLogIndex = events.findIndex((event) => event.type === 'log' && /已就绪/.test(event.message));
  assert.ok(readyLogIndex > -1);
  assert.ok(completeIndex > readyLogIndex);
  assert.equal(events.some((event) => event.type === 'sleep' && event.ms === 20000), false);
});

test('GoPay plus checkout create forwards gopay payment method to the checkout content script', async () => {
  const events = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 99 }),
        update: async () => {},
      },
    },
    completeStepFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    registerTab: async () => {},
    sendTabMessageUntilStopped: async (_tabId, _source, message) => {
      events.push(message);
      return {
        checkoutUrl: 'https://chatgpt.com/checkout/openai_llc/test-session',
        country: 'ID',
        currency: 'IDR',
      };
    },
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({ plusPaymentMethod: 'gopay' });

  assert.deepStrictEqual(events[0]?.payload, { paymentMethod: 'gopay' });
});

test('GPC checkout injects Plus script before reading ChatGPT session token and sends X-API-Key', async () => {
  const events = [];
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async (message, level = 'info') => events.push({ type: 'log', message, level }),
    chrome: {
      tabs: {
        create: async (payload) => {
          events.push({ type: 'tab-create', payload });
          return { id: 77 };
        },
        remove: async (tabId) => events.push({ type: 'tab-remove', tabId }),
      },
    },
    completeStepFromBackground: async (step, payload) => events.push({ type: 'complete', step, payload }),
    ensureContentScriptReadyOnTabUntilStopped: async (source, tabId, options) => events.push({ type: 'ready', source, tabId, options }),
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          message: 'ok',
          data: {
            task_id: 'task_123',
            status: 'active',
            status_text: '处理中',
            phone_mode: 'manual',
            remote_stage: 'checkout_start',
            otp_channel: 'whatsapp',
          },
        }),
      };
    },
    registerTab: async (source, tabId) => events.push({ type: 'register', source, tabId }),
    sendTabMessageUntilStopped: async (tabId, source, message) => {
      events.push({ type: 'tab-message', tabId, source, message });
      return { accessToken: 'session-access-token' };
    },
    setState: async (payload) => events.push({ type: 'set-state', payload }),
    sleepWithStop: async (ms) => events.push({ type: 'sleep', ms }),
    waitForTabCompleteUntilStopped: async () => events.push({ type: 'tab-complete' }),
  });

  await executor.executePlusCheckoutCreate({
    email: 'Current.Round+GPC@Example.COM',
    plusPaymentMethod: 'gpc-helper',
    gopayHelperApiUrl: 'https://gpc.qlhazycoder.top/',
    gopayHelperPhoneNumber: '+8613800138000',
    gopayPhone: '',
    gopayHelperCountryCode: '+86',
    gopayHelperPin: '123456',
    gopayHelperApiKey: 'gpc_test_123',
  });

  const readyIndex = events.findIndex((event) => event.type === 'ready');
  const messageIndex = events.findIndex((event) => event.type === 'tab-message');
  assert.ok(readyIndex >= 0);
  assert.ok(messageIndex > readyIndex);
  assert.equal(events[messageIndex].message.type, 'PLUS_CHECKOUT_GET_STATE');
  assert.deepEqual(events[messageIndex].message.payload, {
    includeSession: true,
    includeAccessToken: true,
  });
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://gpc.qlhazycoder.top/api/gp/tasks');
  const helperPayload = JSON.parse(fetchCalls[0].options.body);
  assert.deepEqual(helperPayload, {
    access_token: 'session-access-token',
    phone_mode: 'manual',
    country_code: '86',
    phone_number: '13800138000',
    otp_channel: 'whatsapp',
  });
  assert.equal(fetchCalls[0].options.headers['X-API-Key'], 'gpc_test_123');
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'card_key'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'customer_email'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'checkout_ui_mode'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'gopay_link'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'plan_name'), false);
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.plusCheckoutSource, 'gpc-helper');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperTaskId, 'task_123');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperTaskStatus, 'active');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperStatusText, '处理中');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperRemoteStage, 'checkout_start');
  assert.equal(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperReferenceId, '');
  assert.ok(events.find((event) => event.type === 'set-state')?.payload?.gopayHelperOrderCreatedAt > 0);
  assert.equal(events.find((event) => event.type === 'complete')?.step, 6);
  assert.equal(events.find((event) => event.type === 'complete')?.payload?.plusCheckoutSource, 'gpc-helper');
});

test('GPC checkout forwards selected SMS OTP channel', async () => {
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => ({ id: 88 }),
        remove: async () => {},
      },
    },
    completeStepFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 200,
          message: 'ok',
          data: { task_id: 'task_sms', status: 'active', phone_mode: 'manual', remote_stage: 'checkout_start' },
        }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => ({ accessToken: 'session-access-token' }),
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await executor.executePlusCheckoutCreate({
    email: 'sms@example.com',
    plusPaymentMethod: 'gpc-helper',
    gopayHelperApiUrl: 'https://gpc.qlhazycoder.top/',
    gopayHelperPhoneNumber: '+8613800138000',
    gopayHelperCountryCode: '+86',
    gopayHelperPin: '123456',
    gopayHelperApiKey: 'gpc_sms',
    gopayHelperOtpChannel: 'sms',
  });

  const helperPayload = JSON.parse(fetchCalls[0].options.body);
  assert.equal(helperPayload.phone_mode, 'manual');
  assert.equal(helperPayload.otp_channel, 'sms');
  assert.equal(fetchCalls[0].options.headers['X-API-Key'], 'gpc_sms');
  assert.equal(Object.prototype.hasOwnProperty.call(helperPayload, 'card_key'), false);
});

test('GPC checkout surfaces unified queue API errors', async () => {
  const fetchCalls = [];
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeStepFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      return {
        ok: false,
        status: 400,
        json: async () => ({
          code: 400,
          message: 'invalid_param',
          data: { detail: 'access_token 无效' },
        }),
      };
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => {},
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      email: 'paid@example.com',
      plusPaymentMethod: 'gpc-helper',
      gopayHelperApiUrl: 'https://gpc.qlhazycoder.top/',
      chatgptAccessToken: 'state-access-token',
      gopayHelperPhoneNumber: '+8613800138000',
      gopayHelperCountryCode: '+86',
      gopayHelperPin: '123456',
      gopayHelperApiKey: 'gpc_paid_456',
    }),
    /创建 GPC 订单失败：access_token 无效/
  );

  assert.equal(fetchCalls.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(fetchCalls[0].options.body), 'card_key'), false);
  assert.equal(fetchCalls[0].options.headers['X-API-Key'], 'gpc_paid_456');
});

test('GPC checkout does not fall back to browser GoPay phone fields', async () => {
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeStepFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => {
      throw new Error('should not call helper API without helper phone');
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => {},
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      plusPaymentMethod: 'gpc-helper',
      gopayHelperApiUrl: 'https://gpc.qlhazycoder.top/',
      chatgptAccessToken: 'state-access-token',
      email: 'helper-phone-test@example.com',
      gopayPhone: '+8613800138000',
      gopayCountryCode: '+86',
      gopayPin: '123456',
      gopayHelperPhoneNumber: '',
      gopayHelperPin: '123456',
      gopayHelperApiKey: 'gpc_phone_test',
    }),
    /缺少手机号/
  );
});

test('GPC checkout rejects missing API Key before calling helper API', async () => {
  const executor = api.createPlusCheckoutCreateExecutor({
    addLog: async () => {},
    chrome: {
      tabs: {
        create: async () => {
          throw new Error('should not open token tab when direct access token exists');
        },
        remove: async () => {},
      },
    },
    completeStepFromBackground: async () => {},
    ensureContentScriptReadyOnTabUntilStopped: async () => {},
    fetch: async () => {
      throw new Error('should not call helper API without API Key');
    },
    registerTab: async () => {},
    sendTabMessageUntilStopped: async () => {},
    setState: async () => {},
    sleepWithStop: async () => {},
    waitForTabCompleteUntilStopped: async () => {},
  });

  await assert.rejects(
    () => executor.executePlusCheckoutCreate({
      plusPaymentMethod: 'gpc-helper',
      gopayHelperApiUrl: 'https://gpc.qlhazycoder.top/',
      chatgptAccessToken: 'state-access-token',
      email: 'missing-card@example.com',
      gopayHelperPhoneNumber: '+8613800138000',
      gopayHelperCountryCode: '+86',
      gopayHelperPin: '123456',
      gopayHelperApiKey: '',
    }),
    /缺少 API Key/
  );
});
