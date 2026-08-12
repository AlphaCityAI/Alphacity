const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const html = fs.readFileSync('verify/index.html', 'utf8');
const app = fs.readFileSync('verify/app.js', 'utf8');
const css = fs.readFileSync('verify/styles.css', 'utf8');
const walletConnector = fs.readFileSync('shared/wallet-connector.js', 'utf8');
const ciWorkflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
const deployWorkflow = fs.readFileSync('.github/workflows/deploy.yml', 'utf8');
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

test('shared wallet choice, message review, sign, and submit are separate stages', () => {
  assert.match(html, /id="connectWalletButton"/);
  assert.match(html, /id="ownershipMessage"/);
  assert.match(html, /id="signButton"/);
  assert.match(html, /id="submitButton"/);
  assert.match(app, /AlphaCityWalletConnector\.create/);
  assert.match(app, /alwaysPrompt:\s*true/);
  assert.match(app, /autoReconnect:\s*false/);
  assert.match(app, /persistSession:\s*false/);
  assert.match(app, /requirePersonalMessage:\s*true/);
  assert.ok(
    app.indexOf('initWalletConnector()') < app.indexOf("signButton.addEventListener"),
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
  assert.match(app, /verification_completed/);
  assert.match(app, /Result not confirmed/);
});

test('verification service routing fails closed and requests are bounded', () => {
  assert.match(app, /apiConfigurationError/);
  assert.match(app, /untrusted verification API URL/);
  assert.doesNotMatch(app, /apiHostAllowed \? requestedApiUrl : new URL\(DEFAULT_API_VERIFY_URL\)/);
  assert.match(app, /CONTEXT_TIMEOUT_MS/);
  assert.match(app, /SUBMISSION_TIMEOUT_MS/);
  assert.match(app, /fetchJsonWithTimeout/);
  assert.match(app, /submissionInFlight/);
});

test('universal connector supports explicit modern and legacy Sui wallet selection', () => {
  assert.match(html, /\/shared\/wallet-connector\.js/);
  assert.match(walletConnector, /new CustomEvent\('wallet-standard:app-ready'/);
  assert.match(walletConnector, /return \(\) => wallets\.forEach/);
  assert.match(walletConnector, /sui:mainnet/);
  assert.match(walletConnector, /root\.slush\?\.sui/);
  assert.match(walletConnector, /sui:signPersonalMessage/);
  assert.match(walletConnector, /sui:signMessage/);
  assert.doesNotMatch(walletConnector, /standard:signMessage/);
  assert.match(walletConnector, /alwaysPrompt/);
  assert.match(walletConnector, /signPersonalMessage/);
  assert.match(walletConnector, /wallets\.filter\(\(wallet\) => wallet\.supportsPersonalMessage\)/);
  assert.doesNotMatch(app, /wallet-standard:register-wallet/);
});

test('verification telemetry contains no wallet or session identifiers', () => {
  assert.match(app, /track\('transaction_sign'/);
  assert.match(app, /track\('gate_check'/);
  assert.match(walletConnector, /telemetryWalletProvider/);
  const trackCalls = [...(app + walletConnector).matchAll(/\btrack\('[^;]+\);/g)]
    .map(match => match[0]).join('\n');
  assert.doesNotMatch(trackCalls, /\b(?:address|signature|session|balance|telegram)\s*:/i);
  assert.doesNotMatch(trackCalls, /provider:\s*(?:wallet|adapter|nextAdapter)\.name/);
});

test('verification regressions gate pull requests and production deployment', () => {
  assert.match(ciWorkflow, /pull_request:/);
  assert.match(ciWorkflow, /npm test/);
  assert.match(ciWorkflow, /npm audit --audit-level=high/);
  assert.match(deployWorkflow, /npm test/);
  assert.match(deployWorkflow, /npm audit --audit-level=high/);
  assert.ok(
    deployWorkflow.indexOf('npm test') <
      deployWorkflow.indexOf('actions\/upload-pages-artifact'),
  );
});

test('verification page uses external assets without inline execution or styles', () => {
  assert.match(html, /href="styles\.css\?v=/);
  assert.match(html, /src="app\.js\?v=/);
  assert.match(html, /src="\/shared\/wallet-connector\.js\?v=/);
  assert.match(html, /data-wallet-connector-styles="external"/);
  assert.match(walletConnector, /dataset\.walletConnectorStyles === 'external'/);
  assert.equal(html.includes('<style>'), false);
  assert.equal(html.includes("'unsafe-inline'"), false);
  const executableInlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim());
  assert.equal(executableInlineScripts.length, 0);
  assert.ok(css.length > 1000);
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /--bg:\s*#111827/);
  assert.match(css, /--card:\s*#1f2937/);
  assert.match(css, /\.ac-wallet-overlay/);
  assert.match(css, /\.ac-wallet-dialog/);
});

test('verification page script parses', () => {
  new Function(app);
});
