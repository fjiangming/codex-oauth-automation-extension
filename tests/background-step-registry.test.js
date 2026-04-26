const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('background imports step registry and shared step definitions', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /background\/steps\/registry\.js/);
  assert.match(source, /data\/step-definitions\.js/);
  assert.match(source, /MultiPageStepDefinitions\?\.getSteps/);
  assert.match(source, /getStepRegistryForState\(state\)/);
  assert.match(source, /activeStepRegistry\.executeStep\(step,\s*\{/);
  assert.match(source, /background\/steps\/create-plus-checkout\.js/);
  assert.match(source, /background\/steps\/fill-plus-checkout\.js/);
  assert.match(source, /background\/steps\/paypal-approve\.js/);
  assert.match(source, /background\/steps\/plus-return-confirm\.js/);
});
