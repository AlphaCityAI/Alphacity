const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync('verify/index.html', 'utf8');
const app = fs.readFileSync('verify/app.js', 'utf8');
const css = fs.readFileSync('verify/styles.css', 'utf8');
const source = html + '\n' + app;

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

test('verification page uses session context and a minimal signed payload', () => {
  assert.match(app, /verification_session: VERIFICATION_SESSION/);
  assert.match(app, /\/api\/verification-context/);
  assert.match(app, /wallet_address: selectedAddress/);
  assert.match(app, /wallet_signature: selectedSignature/);
  assert.match(app, /Session: ' \+ VERIFICATION_SESSION/);
  assert.match(app, /Telegram user: ' \+ context\.telegram_user_id/);
  assert.match(app, /Group: ' \+ context\.group_id/);
  assert.match(app, /Wallet: ' \+ canonicalAddress\(address\)/);
});

test('connect, account selection, message review, sign, and submit are separate stages', () => {
  assert.match(html, /id="accountPanel"/);
  assert.match(html, /id="ownershipMessage"/);
  assert.match(html, /id="signButton"/);
  assert.match(html, /id="submitButton"/);
  assert.match(app, /renderAccounts\(accounts\)/);
  assert.ok(
    app.indexOf('const accounts = await connectWallet(wallet)') <
      app.indexOf("signButton.addEventListener"),
  );
});

test('session secrets use fragments and are scrubbed after completion', () => {
  assert.match(app, /window\.location\.hash/);
  assert.match(app, /window\.history\.replaceState/);
  assert.match(app, /scrubSensitiveUrl/);
  assert.match(app, /query\.has\('verification_session'\)/);
});

test('verification page has recovery and registered-but-ineligible states', () => {
  assert.match(html, /Request a new link/);
  assert.match(html, /Return to Telegram/);
  assert.match(app, /Wallet registered — requirements not met/);
  assert.match(app, /result\.wallet_registered/);
  assert.match(app, /result\.eligibility_status === 'fail'/);
});

test('verification page uses external assets without inline execution or styles', () => {
  assert.match(html, /href="styles\.css\?v=/);
  assert.match(html, /src="app\.js\?v=/);
  assert.equal(html.includes('<style>'), false);
  assert.equal(html.includes("'unsafe-inline'"), false);
  const executableInlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim());
  assert.equal(executableInlineScripts.length, 0);
  assert.ok(css.length > 1000);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('verification page script parses', () => {
  new Function(app);
});
