const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/signup-page.js', 'utf8');

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
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
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

function extractConst(name) {
  const pattern = new RegExp(`const\\s+${name}\\s*=\\s*[\\s\\S]*?;`);
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`missing const ${name}`);
  }
  return match[0];
}

test('waitForSignupEntryState switches from phone mode to email mode before step 2 fills the address', async () => {
  const api = new Function(`
const logs = [];
const clicks = [];
let phase = 'phone';
let now = 0;

const phoneInput = {
  kind: 'phone',
  getAttribute(name) {
    if (name === 'type') return 'tel';
    return '';
  },
};

const switchButton = {
  textContent: 'Continue using email address',
  value: '',
  disabled: false,
  getAttribute(name) {
    if (name === 'type') return 'button';
    return '';
  },
  getBoundingClientRect() {
    return { width: 200, height: 48 };
  },
};

const emailInput = {
  kind: 'email',
  getAttribute(name) {
    if (name === 'type') return 'email';
    return '';
  },
};

const document = {
  querySelector(selector) {
    if (selector === SIGNUP_EMAIL_INPUT_SELECTOR) {
      return phase === 'email' ? emailInput : null;
    }
    if (selector === SIGNUP_PHONE_INPUT_SELECTOR) {
      return phase === 'phone' ? phoneInput : null;
    }
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'button, a, [role="button"], [role="link"]') {
      return phase === 'phone' ? [switchButton] : [];
    }
    if (selector === 'a, button, [role="button"], [role="link"]') {
      return [];
    }
    if (selector === 'input') {
      return phase === 'phone' ? [phoneInput] : [emailInput];
    }
    return [];
  },
};

const location = {
  href: 'https://chatgpt.com/',
};

const Date = {
  now() {
    return now;
  },
};

${extractConst('SIGNUP_ENTRY_TRIGGER_PATTERN')}
${extractConst('SIGNUP_EMAIL_INPUT_SELECTOR')}
${extractConst('SIGNUP_PHONE_INPUT_SELECTOR')}
${extractConst('SIGNUP_SWITCH_TO_EMAIL_PATTERN')}
${extractConst('SIGNUP_SWITCH_ACTION_PATTERN')}
${extractConst('SIGNUP_EMAIL_ACTION_PATTERN')}
${extractConst('SIGNUP_PHONE_ACTION_PATTERN')}
${extractConst('SIGNUP_SWITCH_TO_PHONE_PATTERN')}
${extractConst('SIGNUP_MORE_OPTIONS_PATTERN')}
${extractConst('SIGNUP_WORK_EMAIL_PATTERN')}

function isVisibleElement(el) {
  return Boolean(el);
}

function isActionEnabled(el) {
  return Boolean(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}

function getActionText(el) {
  return [el?.textContent, el?.value, el?.getAttribute?.('aria-label'), el?.getAttribute?.('title')]
    .filter(Boolean)
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function getSignupPasswordInput() {
  return null;
}

function isSignupPasswordPage() {
  return false;
}

function getSignupPasswordSubmitButton() {
  return null;
}

function findSignupEntryTrigger() {
  return null;
}

function getSignupPasswordDisplayedEmail() {
  return '';
}

function throwIfStopped() {}

function log(message, level = 'info') {
  logs.push({ message, level });
}

async function humanPause() {}

function simulateClick(target) {
  clicks.push(getActionText(target));
  if (target === switchButton) {
    phase = 'email';
  }
}

async function sleep(ms) {
  now += ms;
}

${extractFunction('getSignupEmailInput')}
${extractFunction('getSignupPhoneInput')}
${extractFunction('findSignupUseEmailTrigger')}
${extractFunction('findSignupUsePhoneTrigger')}
${extractFunction('findSignupMoreOptionsTrigger')}
${extractFunction('getSignupEmailContinueButton')}
${extractFunction('inspectSignupEntryState')}
${extractFunction('waitForSignupEntryState')}

return {
  async run() {
    return waitForSignupEntryState({ timeout: 5000, autoOpenEntry: true });
  },
  getClicks() {
    return clicks.slice();
  },
  getLogs() {
    return logs.slice();
  },
};
`)();

  const snapshot = await api.run();

  assert.equal(snapshot.state, 'email_entry');
  assert.deepEqual(api.getClicks(), ['Continue using email address']);
  assert.equal(api.getLogs().length > 0, true);
});

test('waitForSignupEntryState also recognizes the Chinese switch-to-email button text', async () => {
  const api = new Function(`
const logs = [];
const clicks = [];
let phase = 'phone';
let now = 0;

const phoneInput = {
  kind: 'phone',
  getAttribute(name) {
    if (name === 'type') return 'tel';
    return '';
  },
};

const switchButton = {
  textContent: '\\u7ee7\\u7eed\\u4f7f\\u7528\\u7535\\u5b50\\u90ae\\u4ef6\\u5730\\u5740\\u767b\\u5f55',
  value: '',
  disabled: false,
  getAttribute(name) {
    if (name === 'type') return 'button';
    return '';
  },
  getBoundingClientRect() {
    return { width: 200, height: 48 };
  },
};

const workEmailButton = {
  textContent: '\\u7ee7\\u7eed\\u4f7f\\u7528\\u5de5\\u4f5c\\u7535\\u5b50\\u90ae\\u4ef6\\u5730\\u5740\\u767b\\u5f55',
  value: '',
  disabled: false,
  getAttribute(name) {
    if (name === 'type') return 'button';
    return '';
  },
  getBoundingClientRect() {
    return { width: 200, height: 48 };
  },
};

const emailInput = {
  kind: 'email',
  getAttribute(name) {
    if (name === 'type') return 'email';
    return '';
  },
};

const document = {
  querySelector(selector) {
    if (selector === SIGNUP_EMAIL_INPUT_SELECTOR) {
      return phase === 'email' ? emailInput : null;
    }
    if (selector === SIGNUP_PHONE_INPUT_SELECTOR) {
      return phase === 'phone' ? phoneInput : null;
    }
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'button, a, [role="button"], [role="link"]') {
      return phase === 'phone' ? [switchButton, workEmailButton] : [];
    }
    if (selector === 'a, button, [role="button"], [role="link"]') {
      return [];
    }
    if (selector === 'input') {
      return phase === 'phone' ? [phoneInput] : [emailInput];
    }
    return [];
  },
};

const location = {
  href: 'https://chatgpt.com/',
};

const Date = {
  now() {
    return now;
  },
};

${extractConst('SIGNUP_ENTRY_TRIGGER_PATTERN')}
${extractConst('SIGNUP_EMAIL_INPUT_SELECTOR')}
${extractConst('SIGNUP_PHONE_INPUT_SELECTOR')}
${extractConst('SIGNUP_SWITCH_TO_EMAIL_PATTERN')}
${extractConst('SIGNUP_SWITCH_ACTION_PATTERN')}
${extractConst('SIGNUP_EMAIL_ACTION_PATTERN')}
${extractConst('SIGNUP_PHONE_ACTION_PATTERN')}
${extractConst('SIGNUP_SWITCH_TO_PHONE_PATTERN')}
${extractConst('SIGNUP_MORE_OPTIONS_PATTERN')}
${extractConst('SIGNUP_WORK_EMAIL_PATTERN')}

function isVisibleElement(el) {
  return Boolean(el);
}

function isActionEnabled(el) {
  return Boolean(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}

function getActionText(el) {
  return [el?.textContent, el?.value, el?.getAttribute?.('aria-label'), el?.getAttribute?.('title')]
    .filter(Boolean)
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function getSignupPasswordInput() {
  return null;
}

function isSignupPasswordPage() {
  return false;
}

function getSignupPasswordSubmitButton() {
  return null;
}

function findSignupEntryTrigger() {
  return null;
}

function getSignupPasswordDisplayedEmail() {
  return '';
}

function throwIfStopped() {}

function log(message, level = 'info') {
  logs.push({ message, level });
}

async function humanPause() {}

function simulateClick(target) {
  clicks.push(getActionText(target));
  if (target === switchButton) {
    phase = 'email';
  }
}

async function sleep(ms) {
  now += ms;
}

${extractFunction('getSignupEmailInput')}
${extractFunction('getSignupPhoneInput')}
${extractFunction('findSignupUseEmailTrigger')}
${extractFunction('findSignupUsePhoneTrigger')}
${extractFunction('findSignupMoreOptionsTrigger')}
${extractFunction('getSignupEmailContinueButton')}
${extractFunction('inspectSignupEntryState')}
${extractFunction('waitForSignupEntryState')}

return {
  async run() {
    return waitForSignupEntryState({ timeout: 5000, autoOpenEntry: true });
  },
  getClicks() {
    return clicks.slice();
  },
};
`)();

  const snapshot = await api.run();

  assert.equal(snapshot.state, 'email_entry');
  assert.deepEqual(api.getClicks(), ['继续使用电子邮件地址登录']);
});

test('getSignupEmailInput recognizes localized email placeholders in text inputs', () => {
  const api = new Function(`
const localizedEmailInput = {
  kind: 'localized-email',
  getAttribute(name) {
    if (name === 'placeholder') return '电子邮件地址';
    if (name === 'type') return 'text';
    return '';
  },
};

const document = {
  querySelector() {
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'input') {
      return [localizedEmailInput];
    }
    return [];
  },
};

${extractConst('SIGNUP_EMAIL_INPUT_SELECTOR')}

function isVisibleElement(el) {
  return Boolean(el);
}

${extractFunction('getSignupEmailInput')}

return {
  run() {
    return getSignupEmailInput();
  },
};
`)();

  assert.equal(api.run()?.kind, 'localized-email');
});

test('submitSignupPhoneNumberAndContinue switches from email mode to phone mode and submits local number', async () => {
  const api = new Function(`
const logs = [];
const clicks = [];
const filled = [];
let phase = 'email';
let now = 0;

const emailInput = {
  kind: 'email',
  value: '',
  getAttribute(name) {
    if (name === 'type') return 'email';
    return '';
  },
};

const phoneInput = {
  kind: 'phone',
  value: '',
  textContent: 'Thailand (+66)',
  getAttribute(name) {
    if (name === 'type') return 'tel';
    return '';
  },
  closest() {
    return { textContent: 'Thailand (+66)' };
  },
};

const switchButton = {
  textContent: 'Continue with phone number',
  value: '',
  disabled: false,
  getAttribute(name) {
    if (name === 'type') return 'button';
    return '';
  },
  getBoundingClientRect() {
    return { width: 200, height: 48 };
  },
};

const continueButton = {
  textContent: 'Continue',
  value: '',
  disabled: false,
  getAttribute(name) {
    if (name === 'type') return 'submit';
    if (name === 'aria-disabled') return 'false';
    return '';
  },
  getBoundingClientRect() {
    return { width: 200, height: 48 };
  },
};

const document = {
  querySelector(selector) {
    if (selector === SIGNUP_EMAIL_INPUT_SELECTOR) {
      return phase === 'email' ? emailInput : null;
    }
    if (selector === SIGNUP_PHONE_INPUT_SELECTOR) {
      return phase === 'phone' ? phoneInput : null;
    }
    if (selector === 'button[type="submit"], input[type="submit"]') {
      return phase === 'phone' ? continueButton : null;
    }
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'button, a, [role="button"], [role="link"]') {
      return phase === 'email' ? [switchButton] : [];
    }
    if (selector === 'a, button, [role="button"], [role="link"]') {
      return [];
    }
    if (selector === 'button, a, [role="button"], [role="link"], input[type="button"], input[type="submit"]') {
      return phase === 'phone' ? [continueButton] : [];
    }
    if (selector === 'input') {
      return phase === 'phone' ? [phoneInput] : [emailInput];
    }
    return [];
  },
};

const location = {
  href: 'https://chatgpt.com/',
};

const window = {
  setTimeout(fn) {
    fn();
  },
};

const Date = {
  now() {
    return now;
  },
};

${extractConst('SIGNUP_ENTRY_TRIGGER_PATTERN')}
${extractConst('SIGNUP_EMAIL_INPUT_SELECTOR')}
${extractConst('SIGNUP_PHONE_INPUT_SELECTOR')}
${extractConst('SIGNUP_SWITCH_TO_EMAIL_PATTERN')}
${extractConst('SIGNUP_SWITCH_ACTION_PATTERN')}
${extractConst('SIGNUP_EMAIL_ACTION_PATTERN')}
${extractConst('SIGNUP_WORK_EMAIL_PATTERN')}
${extractConst('SIGNUP_PHONE_ACTION_PATTERN')}
${extractConst('SIGNUP_SWITCH_TO_PHONE_PATTERN')}
${extractConst('SIGNUP_MORE_OPTIONS_PATTERN')}

function isVisibleElement(el) {
  return Boolean(el);
}

function isActionEnabled(el) {
  return Boolean(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
}

function getActionText(el) {
  return [el?.textContent, el?.value, el?.getAttribute?.('aria-label'), el?.getAttribute?.('title')]
    .filter(Boolean)
    .join(' ')
    .replace(/\\s+/g, ' ')
    .trim();
}

function getSignupPasswordInput() {
  return null;
}

function isSignupPasswordPage() {
  return false;
}

function getSignupPasswordSubmitButton() {
  return null;
}

function findSignupEntryTrigger() {
  return null;
}

function getSignupPasswordDisplayedEmail() {
  return '';
}

function getPageTextSnapshot() {
  return phase === 'phone' ? 'Thailand (+66)' : '';
}

function throwIfStopped() {}
function isStopError() { return false; }

function log(message, level = 'info') {
  logs.push({ message, level });
}

async function humanPause() {}

function simulateClick(target) {
  clicks.push(getActionText(target));
  if (target === switchButton) {
    phase = 'phone';
  }
}

function fillInput(target, value) {
  target.value = value;
  filled.push({ target: target.kind, value });
}

async function sleep(ms) {
  now += ms;
}

${extractFunction('getSignupEmailInput')}
${extractFunction('getSignupPhoneInput')}
${extractFunction('findSignupUseEmailTrigger')}
${extractFunction('findSignupUsePhoneTrigger')}
${extractFunction('findSignupMoreOptionsTrigger')}
${extractFunction('getSignupEmailContinueButton')}
${extractFunction('inspectSignupEntryState')}
${extractFunction('getSignupEntryStateSummary')}
function getSignupEntryDiagnostics() { return {}; }
${extractFunction('normalizePhoneDigits')}
${extractFunction('extractDialCodeFromText')}
${extractFunction('toNationalPhoneNumber')}
${extractFunction('resolveSignupPhoneDialCode')}
${extractFunction('waitForSignupPhoneEntryState')}
${extractFunction('submitSignupPhoneNumberAndContinue')}

return {
  async run() {
    return submitSignupPhoneNumberAndContinue({
      phoneNumber: '66959916439',
      countryLabel: 'Thailand',
    });
  },
  getClicks() {
    return clicks.slice();
  },
  getFilled() {
    return filled.slice();
  },
};
`)();

  const result = await api.run();

  assert.equal(result.submitted, true);
  assert.equal(result.phoneInputValue, '959916439');
  assert.deepEqual(api.getClicks(), ['Continue with phone number', 'Continue']);
  assert.deepEqual(api.getFilled(), [{ target: 'phone', value: '959916439' }]);
});
