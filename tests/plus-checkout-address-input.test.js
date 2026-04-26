const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('content/plus-checkout.js', 'utf8');

function extractFunction(name) {
  const plainStart = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0
    ? asyncStart
    : plainStart;
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = index;
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

function createInput({ id = '', name = '', placeholder = '', containerText = '' }) {
  const attrs = {
    id,
    name,
    placeholder,
    type: 'text',
  };
  const container = {
    textContent: containerText,
  };
  return {
    id,
    name,
    type: 'text',
    value: '',
    textContent: '',
    getAttribute: (key) => attrs[key] || '',
    closest: (selector) => {
      if (selector === 'label') return null;
      if (String(selector || '').includes('[data-testid]')) return container;
      return null;
    },
    getBoundingClientRect: () => ({ width: 240, height: 40 }),
  };
}

function createElement({ tagName = 'BUTTON', text = '', attrs = {}, className = '' }) {
  return {
    tagName,
    textContent: text,
    value: '',
    className,
    dataset: {},
    id: attrs.id || '',
    checked: false,
    getAttribute: (key) => attrs[key] || '',
    closest: () => null,
    getBoundingClientRect: () => ({ width: 180, height: 64 }),
  };
}

test('findAddressSearchInput skips the name field when its container says billing address', async () => {
  const bundle = [
    'function throwIfStopped() {}',
    'function sleep() { return Promise.resolve(); }',
    extractFunction('waitUntil'),
    extractFunction('isVisibleElement'),
    extractFunction('normalizeText'),
    extractFunction('getActionText'),
    extractFunction('getFieldText'),
    extractFunction('getVisibleControls'),
    extractFunction('getVisibleTextInputs'),
    extractFunction('findInputByFieldText'),
    extractFunction('getDirectFieldHintText'),
    extractFunction('isNonAddressSearchInput'),
    extractFunction('isLikelyAddressSearchInput'),
    extractFunction('findAddressSearchInput'),
  ].join('\n');

  const nameInput = createInput({
    name: 'name',
    placeholder: 'Name',
    containerText: 'Billing address',
  });
  const addressInput = createInput({
    name: 'addressLine1',
    placeholder: 'Address',
    containerText: 'Billing address',
  });
  const inputs = [nameInput, addressInput];
  const documentMock = {
    readyState: 'complete',
    querySelectorAll: (selector) => {
      if (selector === 'input, textarea') return inputs;
      return [];
    },
  };
  const windowMock = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  const cssMock = {
    escape: (value) => String(value),
  };

  const api = new Function('window', 'document', 'CSS', `
${bundle}
return { findAddressSearchInput, isNonAddressSearchInput };
`)(windowMock, documentMock, cssMock);

  assert.equal(api.isNonAddressSearchInput(nameInput), true);
  assert.equal(await api.findAddressSearchInput(), addressInput);
});

test('isPayPalPaymentMethodActive requires a selected PayPal control', () => {
  const bundle = [
    extractFunction('isVisibleElement'),
    extractFunction('normalizeText'),
    extractFunction('getActionText'),
    extractFunction('getSearchText'),
    extractFunction('getFieldText'),
    extractFunction('getCombinedSearchText'),
    extractFunction('getVisibleControls'),
    extractFunction('getVisibleTextInputs'),
    extractFunction('isDocumentLevelContainer'),
    extractFunction('getPayPalSearchCandidates'),
    extractFunction('hasCreditCardFields'),
    extractFunction('hasSelectedPayPalControl'),
    extractFunction('isPayPalPaymentMethodActive'),
  ].join('\n');

  const paypalButton = createElement({
    text: 'PayPal',
    attrs: {
      id: 'paypal-tab',
      role: 'tab',
      'aria-selected': '',
    },
  });
  const elements = [paypalButton];
  const documentMock = {
    documentElement: {},
    body: {},
    querySelectorAll: (selector) => {
      if (selector === 'input, textarea') return [];
      if (String(selector || '').includes('label[for=')) return [];
      return elements;
    },
  };
  const windowMock = {
    innerWidth: 1200,
    innerHeight: 900,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  const cssMock = {
    escape: (value) => String(value),
  };

  const api = new Function('window', 'document', 'CSS', `
${bundle}
return { isPayPalPaymentMethodActive };
`)(windowMock, documentMock, cssMock);

  assert.equal(api.isPayPalPaymentMethodActive(), false);
  paypalButton.getAttribute = (key) => (key === 'aria-selected' ? 'true' : (paypalButton.id && key === 'id' ? paypalButton.id : ''));
  assert.equal(api.isPayPalPaymentMethodActive(), true);
});

test('selectRegionDropdown opens the state dropdown and clicks the matching option', async () => {
  const bundle = [
    'function throwIfStopped() {}',
    'function sleep() { return Promise.resolve(); }',
    extractFunction('isVisibleElement'),
    extractFunction('normalizeText'),
    extractFunction('getActionText'),
    extractFunction('getRegionCandidates'),
    extractFunction('matchesRegionOption'),
    extractFunction('getRegionDropdownValue'),
    extractFunction('getVisibleRegionOptions'),
    extractFunction('selectRegionDropdown'),
  ].join('\n');

  const state = { opened: false };
  const clicks = [];
  const stateDropdown = createElement({
    tagName: 'DIV',
    text: 'State New South Wales',
    attrs: {
      role: 'combobox',
      'aria-haspopup': 'listbox',
    },
  });
  const options = [
    createElement({ tagName: 'DIV', text: 'New South Wales', attrs: { role: 'option' } }),
    createElement({ tagName: 'DIV', text: 'Western Australia', attrs: { role: 'option' } }),
  ];
  const documentMock = {
    querySelectorAll: (selector) => {
      if (!state.opened) return [];
      if (selector === '[role="listbox"] [role="option"]' || selector === '[role="option"]') return options;
      if (selector === 'li') return [];
      return [];
    },
  };
  const windowMock = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };

  const api = new Function('window', 'document', 'Event', 'clicks', 'stateDropdown', 'state', `
function simulateClick(el) {
  clicks.push(el);
  if (el === stateDropdown) state.opened = true;
}
${bundle}
return { selectRegionDropdown };
`)(windowMock, documentMock, Event, clicks, stateDropdown, state);

  await api.selectRegionDropdown(stateDropdown, 'Western Australia');

  assert.deepEqual(clicks, [stateDropdown, options[1]]);
});
