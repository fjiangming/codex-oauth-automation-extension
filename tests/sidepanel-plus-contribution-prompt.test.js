const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

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

function extractBundle(names) {
  return names.map((name) => extractFunction(name)).join('\n');
}

function createPlusRecords(count, contributionMode = false) {
  return Array.from({ length: count }, (_, index) => ({
    recordId: `${contributionMode ? 'contribution' : 'plus'}-${index}@example.com`,
    email: `${contributionMode ? 'contribution' : 'plus'}-${index}@example.com`,
    finalStatus: 'success',
    plusModeEnabled: true,
    contributionMode,
  }));
}

test('Plus contribution prompt starts every five normal Plus successes', () => {
  const bundle = extractBundle([
    'normalizePlusContributionPromptNumber',
    'normalizePlusContributionPromptLedger',
    'isSuccessfulPlusAccountRecord',
    'getPlusContributionPromptTotals',
    'getPlusContributionPromptProgress',
    'shouldShowPlusContributionPrompt',
  ]);

  const api = new Function(`
const PLUS_CONTRIBUTION_PROMPT_THRESHOLD = 5;
const PLUS_CONTRIBUTION_ACCOUNT_CREDIT = 5;
${bundle}
return {
  getPlusContributionPromptProgress,
  shouldShowPlusContributionPrompt,
};
`)();

  assert.equal(
    api.shouldShowPlusContributionPrompt(createPlusRecords(4), true, { promptBaseline: 0, donationCredit: 0 }),
    false
  );
  assert.equal(
    api.shouldShowPlusContributionPrompt(createPlusRecords(5), true, { promptBaseline: 0, donationCredit: 0 }),
    true
  );
  assert.equal(
    api.shouldShowPlusContributionPrompt(createPlusRecords(8), false, { promptBaseline: 0, donationCredit: 0 }),
    false
  );
});

test('Plus contribution success and donated credit delay the next prompt', () => {
  const bundle = extractBundle([
    'normalizePlusContributionPromptNumber',
    'normalizePlusContributionPromptLedger',
    'isSuccessfulPlusAccountRecord',
    'getPlusContributionPromptTotals',
    'getPlusContributionPromptProgress',
    'shouldShowPlusContributionPrompt',
  ]);

  const api = new Function(`
const PLUS_CONTRIBUTION_PROMPT_THRESHOLD = 5;
const PLUS_CONTRIBUTION_ACCOUNT_CREDIT = 5;
${bundle}
return { shouldShowPlusContributionPrompt };
`)();

  const afterPromptLedger = { promptBaseline: 5, donationCredit: 0 };
  assert.equal(
    api.shouldShowPlusContributionPrompt(
      [...createPlusRecords(14), ...createPlusRecords(1, true)],
      true,
      afterPromptLedger
    ),
    false
  );
  assert.equal(
    api.shouldShowPlusContributionPrompt(
      [...createPlusRecords(15), ...createPlusRecords(1, true)],
      true,
      afterPromptLedger
    ),
    true
  );

  const donatedLedger = { promptBaseline: 5, donationCredit: 20 };
  assert.equal(api.shouldShowPlusContributionPrompt(createPlusRecords(29), true, donatedLedger), false);
  assert.equal(api.shouldShowPlusContributionPrompt(createPlusRecords(30), true, donatedLedger), true);
});

test('Plus contribution support modal includes WeChat image and expected actions', async () => {
  const bundle = extractBundle([
    'getPlusContributionSupportImageUrl',
    'buildPlusContributionSupportPromptHtml',
    'openPlusContributionSupportModal',
  ]);

  const api = new Function(`
let capturedOptions = null;
const chrome = { runtime: { getURL: (path) => 'chrome-extension://test/' + path } };
function escapeHtml(value) { return String(value || ''); }
async function openActionModal(options) {
  capturedOptions = options;
  return 'donated';
}
${bundle}
return {
  openPlusContributionSupportModal,
  getCapturedOptions() {
    return capturedOptions;
  },
};
`)();

  const choice = await api.openPlusContributionSupportModal();
  const options = api.getCapturedOptions();

  assert.equal(choice, 'donated');
  assert.equal(options.title, 'Plus 功能使用反馈');
  assert.match(options.messageHtml, /docs\/images\/微信\.png/);
  assert.deepEqual(options.actions.map((action) => action.label), ['取消', '去贡献账号', '已打赏']);
});

test('Plus contribution prompt marks shown and donated choice adds twenty credits', async () => {
  const bundle = extractBundle([
    'normalizePlusContributionPromptNumber',
    'normalizePlusContributionPromptLedger',
    'getPlusContributionPromptLedger',
    'setPlusContributionPromptLedger',
    'isSuccessfulPlusAccountRecord',
    'getPlusContributionPromptTotals',
    'getPlusContributionPromptProgress',
    'shouldShowPlusContributionPrompt',
    'markPlusContributionPromptShown',
    'addPlusContributionPromptCredit',
    'maybeShowPlusContributionPromptBeforeAutoRun',
  ]);

  const api = new Function('records', `
const PLUS_CONTRIBUTION_PROMPT_LEDGER_STORAGE_KEY = 'multipage-plus-contribution-prompt-ledger';
const PLUS_CONTRIBUTION_PROMPT_THRESHOLD = 5;
const PLUS_CONTRIBUTION_ACCOUNT_CREDIT = 5;
const PLUS_CONTRIBUTION_DONATION_CREDIT = 20;
const latestState = { accountRunHistory: records };
const storage = {};
const events = [];
const localStorage = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
  setItem(key, value) { storage[key] = String(value); },
};
async function openPlusContributionSupportModal() {
  events.push({ type: 'modal' });
  return 'donated';
}
function showToast(message, type) {
  events.push({ type: 'toast', message, toastType: type });
}
function openExternalUrl(url) {
  events.push({ type: 'open', url });
}
function getContributionPortalUrl() {
  return 'https://apikey.qzz.io';
}
${bundle}
return {
  maybeShowPlusContributionPromptBeforeAutoRun,
  getLedger() {
    return JSON.parse(storage[PLUS_CONTRIBUTION_PROMPT_LEDGER_STORAGE_KEY] || '{}');
  },
  getEvents() {
    return events;
  },
};
`)(createPlusRecords(5));

  const result = await api.maybeShowPlusContributionPromptBeforeAutoRun(true);

  assert.equal(result, true);
  assert.deepEqual(api.getEvents().map((event) => event.type), ['modal', 'toast']);
  assert.deepEqual(api.getLedger(), {
    promptBaseline: 5,
    donationCredit: 20,
  });
});

test('Plus contribution prompt opens portal and aborts normal auto run when contribute is chosen', async () => {
  const bundle = extractBundle([
    'normalizePlusContributionPromptNumber',
    'normalizePlusContributionPromptLedger',
    'getPlusContributionPromptLedger',
    'setPlusContributionPromptLedger',
    'isSuccessfulPlusAccountRecord',
    'getPlusContributionPromptTotals',
    'getPlusContributionPromptProgress',
    'shouldShowPlusContributionPrompt',
    'markPlusContributionPromptShown',
    'addPlusContributionPromptCredit',
    'maybeShowPlusContributionPromptBeforeAutoRun',
  ]);

  const api = new Function('records', `
const PLUS_CONTRIBUTION_PROMPT_LEDGER_STORAGE_KEY = 'multipage-plus-contribution-prompt-ledger';
const PLUS_CONTRIBUTION_PROMPT_THRESHOLD = 5;
const PLUS_CONTRIBUTION_ACCOUNT_CREDIT = 5;
const PLUS_CONTRIBUTION_DONATION_CREDIT = 20;
const latestState = { accountRunHistory: records };
const storage = {};
const events = [];
const localStorage = {
  getItem(key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
  setItem(key, value) { storage[key] = String(value); },
};
async function openPlusContributionSupportModal() {
  events.push({ type: 'modal' });
  return 'contribute';
}
function showToast(message, type) {
  events.push({ type: 'toast', message, toastType: type });
}
function openExternalUrl(url) {
  events.push({ type: 'open', url });
}
function getContributionPortalUrl() {
  return 'https://apikey.qzz.io';
}
${bundle}
return {
  maybeShowPlusContributionPromptBeforeAutoRun,
  getEvents() {
    return events;
  },
};
`)(createPlusRecords(5));

  const result = await api.maybeShowPlusContributionPromptBeforeAutoRun(true);

  assert.equal(result, false);
  assert.deepEqual(api.getEvents().map((event) => event.type), ['modal', 'open', 'toast']);
  assert.equal(api.getEvents()[1].url, 'https://apikey.qzz.io');
});
