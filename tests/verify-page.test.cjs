const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('verify/index.html', 'utf8');

test('verification page contains no legacy Sui RPC client or browser authority', () => {
  for (const forbidden of [
    '/shared/sui-client.js',
    'AlphaCitySui',
    'jsonrpc',
    'suix_',
    'sui_getObject',
    'verify_token',
    'balance_verified',
    'token_balance:',
    'nft_count:',
  ]) {
    assert.equal(source.includes(forbidden), false, `found forbidden text: ${forbidden}`);
  }
});

test('verification page uses session context and minimal signed payload', () => {
  assert.match(source, /verification_session/);
  assert.match(source, /\/api\/verification-context/);
  assert.match(source, /wallet_address: selectedAddress/);
  assert.match(source, /wallet_signature: selectedSignature/);
  assert.match(source, /Session: ' \+ VERIFICATION_SESSION/);
  assert.match(source, /Telegram user: ' \+ context\.telegram_user_id/);
  assert.match(source, /Group: ' \+ context\.group_id/);
  assert.match(source, /Wallet: ' \+ canonicalAddress\(address\)/);
});

test('verification page script parses', () => {
  const inlineScripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim());
  assert.ok(inlineScripts.length > 0);
  for (const script of inlineScripts) {
    new Function(script);
  }
});
