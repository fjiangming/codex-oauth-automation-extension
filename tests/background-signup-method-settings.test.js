const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') parenDepth += 1;
    if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) signatureEnded = true;
    }
    if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

test('signup method resolution freezes per run and falls back when phone signup is unavailable', async () => {
  const api = new Function(`
const SIGNUP_METHOD_EMAIL = 'email';
const SIGNUP_METHOD_PHONE = 'phone';
const DEFAULT_SIGNUP_METHOD = SIGNUP_METHOD_EMAIL;
const logs = [];
let state = {
  signupMethod: 'phone',
  phoneVerificationEnabled: true,
  plusModeEnabled: false,
  contributionMode: false,
  resolvedSignupMethod: null,
};
async function getState() { return { ...state }; }
async function setState(updates) { state = { ...state, ...updates }; }
async function addLog(message, level = 'info') { logs.push({ message, level }); }
${extractFunction('normalizeSignupMethod')}
${extractFunction('canUsePhoneSignup')}
${extractFunction('resolveSignupMethod')}
${extractFunction('ensureResolvedSignupMethodForRun')}
return {
  logs,
  get state() { return state; },
  setState,
  resolveSignupMethod,
  ensureResolvedSignupMethodForRun,
};
`)();

  assert.equal(api.resolveSignupMethod({ signupMethod: 'phone', phoneVerificationEnabled: true }), 'phone');
  assert.equal(api.resolveSignupMethod({ signupMethod: 'phone', phoneVerificationEnabled: false }), 'email');
  assert.equal(api.resolveSignupMethod({ signupMethod: 'phone', phoneVerificationEnabled: true, plusModeEnabled: true }), 'email');
  assert.equal(api.resolveSignupMethod({ signupMethod: 'email', resolvedSignupMethod: 'phone', phoneVerificationEnabled: false }), 'phone');

  assert.equal(await api.ensureResolvedSignupMethodForRun(), 'phone');
  assert.equal(api.state.resolvedSignupMethod, 'phone');

  await api.setState({ signupMethod: 'email', phoneVerificationEnabled: false });
  assert.equal(await api.ensureResolvedSignupMethodForRun(), 'phone');
  assert.equal(api.state.resolvedSignupMethod, 'phone');

  await api.setState({ resolvedSignupMethod: null, signupMethod: 'phone', phoneVerificationEnabled: false });
  assert.equal(await api.ensureResolvedSignupMethodForRun({ force: true }), 'email');
  assert.equal(api.state.resolvedSignupMethod, 'email');
  assert.equal(api.logs.some((entry) => /固定为邮箱注册/.test(entry.message)), true);
});

