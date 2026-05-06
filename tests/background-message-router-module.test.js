const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports message router module', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/message-router\.js/);
});

test('background defaults enable free phone reuse switches', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  const defaultsStart = source.indexOf('const PERSISTED_SETTING_DEFAULTS = {');
  const defaultsEnd = source.indexOf('const PERSISTED_SETTING_KEYS = Object.keys(PERSISTED_SETTING_DEFAULTS);');
  const defaultsBlock = source.slice(defaultsStart, defaultsEnd);

  assert.match(defaultsBlock, /freePhoneReuseEnabled:\s*true/);
  assert.match(defaultsBlock, /freePhoneReuseAutoEnabled:\s*true/);
});

test('background free reusable phone setter does not depend on module-scoped phone flow constants', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  const setterStart = source.indexOf('async function setFreeReusablePhoneActivation');
  const setterEnd = source.indexOf('// ============================================================\n// Tab Registry', setterStart);
  const setterBlock = source.slice(setterStart, setterEnd);

  assert.ok(setterStart >= 0, 'expected setFreeReusablePhoneActivation to exist');
  assert.doesNotMatch(setterBlock, /DEFAULT_PHONE_NUMBER_MAX_USES/);
  assert.match(setterBlock, /maxUses:\s*Math\.max\(1,\s*Math\.floor\(Number\(record\.maxUses\)\s*\|\|\s*3\)\)/);
});

test('message router module exposes a factory', () => {
  const source = fs.readFileSync('background/message-router.js', 'utf8');
  const globalScope = {};

  const api = new Function('self', `${source}; return self.MultiPageBackgroundMessageRouter;`)(globalScope);

  assert.equal(typeof api?.createMessageRouter, 'function');
});

test('SAVE_SETTING broadcasts free phone reuse setting updates for realtime sidepanel sync', async () => {
  const source = fs.readFileSync('background/message-router.js', 'utf8');
  const globalScope = { console };
  const api = new Function('self', `${source}; return self.MultiPageBackgroundMessageRouter;`)(globalScope);
  const broadcasts = [];
  let state = {
    freePhoneReuseEnabled: false,
    freePhoneReuseAutoEnabled: false,
    plusModeEnabled: false,
    plusPaymentMethod: 'paypal',
  };

  const router = api.createMessageRouter({
    addLog: async () => {},
    buildLuckmailSessionSettingsPayload: () => ({}),
    buildPersistentSettingsPayload: (input = {}) => {
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(input, 'freePhoneReuseEnabled')) {
        updates.freePhoneReuseEnabled = Boolean(input.freePhoneReuseEnabled);
      }
      if (Object.prototype.hasOwnProperty.call(input, 'freePhoneReuseAutoEnabled')) {
        updates.freePhoneReuseAutoEnabled = Boolean(input.freePhoneReuseAutoEnabled);
      }
      return updates;
    },
    broadcastDataUpdate: (payload) => broadcasts.push(payload),
    getState: async () => ({ ...state }),
    setPersistentSettings: async () => {},
    setState: async (updates) => {
      state = { ...state, ...updates };
    },
  });

  const response = await router.handleMessage({
    type: 'SAVE_SETTING',
    payload: {
      freePhoneReuseEnabled: true,
      freePhoneReuseAutoEnabled: true,
    },
  });

  assert.equal(response.ok, true);
  assert.equal(state.freePhoneReuseEnabled, true);
  assert.equal(state.freePhoneReuseAutoEnabled, true);
  assert.ok(
    broadcasts.some((payload) => (
      payload.freePhoneReuseEnabled === true
      && payload.freePhoneReuseAutoEnabled === true
    )),
    'expected SAVE_SETTING to broadcast free reuse switch updates'
  );
});
