'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'sluice', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'sluice', 'app-source.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'sluice', 'sluice.css'), 'utf8');
const contract = fs.readFileSync(path.join(root, 'contracts', 'sluice', 'sources', 'sluice_v2.move'), 'utf8');

test('Sluice is public for viewing and claims, with creation gated in-app', () => {
    assert.doesNotMatch(html, /tools-gate\.js/);
    assert.match(source, /CREATION_GATE = 1_000_000n \* 1_000_000_000n/);
    assert.match(source, /refreshGate/);
    assert.match(source, /Viewing and claiming remain public/);
});

test('Sluice uses locally bundled SDK code and runtime config', () => {
    assert.match(html, /\/shared\/sui-client\.js/);
    assert.match(html, /\/shared\/wallet-sync\.js/);
    assert.match(html, /\/shared\/wallet-connector\.js/);
    assert.match(html, /\/sluice\/config\.js/);
    assert.match(html, /\/sluice\/app\.js/);
    assert.doesNotMatch(html, /esm\.sh|cdn\.tailwindcss\.com/);
});

test('Sluice uses the shared wallet connector for options and transaction signing', () => {
    assert.match(source, /AlphaCityWalletConnector\.create/);
    assert.match(source, /walletConnector\.signAndExecuteTransaction\(tx\)/);
    assert.doesNotMatch(source, /wallet-standard:app-ready|function discoverWallets|function connectWallet|function disconnectWallet/);
    assert.doesNotMatch(html, /id="wallet-modal"|id="wallet-label"/);
});

test('the wider creator panel keeps timeline controls usable', () => {
    assert.match(css, /grid-template-columns:\s*minmax\(560px,\s*600px\)\s+minmax\(0,\s*1fr\)/);
    assert.match(css, /#coin-type,\s*#token-amount,\s*#unlock-frequency\s*\{[^}]*420px/);
    assert.match(css, /\.two-columns\s*>\s*\*\s*\{\s*min-width:\s*0/);
});

test('triggered schedules fail closed against the same live feed used by the relayer', () => {
    assert.match(html, /id="minimum-liquidity"[^>]*value="10000"/);
    assert.match(source, /validateTriggerFeed\(\{ coinType, triggerKind, minLiquidityUsd: minLiquidity \}\)/);
    assert.match(source, /observationFromPairs/);
    assert.match(source, /Trigger deadline must leave enough time for the full validation window/);
});

test('wallet-sensitive reads cannot authorize a different account after a switch', () => {
    assert.match(source, /const creatorAddress = state\.address/);
    assert.match(source, /refreshGate\(creatorAddress\)/);
    assert.match(source, /sameAddress\(session\?\.address, expectedAddress\)/);
    assert.match(source, /const address = normalizeAddress\(requestedAddress\)/);
});

test('trigger deadlines are final in the contract and relayer', () => {
    assert.match(contract, /now < schedule\.trigger_deadline_ms/);
    assert.match(contract, /trigger_deadline_ms - now_ms >= validation_window_ms/);
    assert.match(contract, /E_TRIGGER_EXPIRED/);
});

test('Sluice uses the established Alpha City visual system', () => {
    assert.match(css, /--bg:\s*#111827/i);
    assert.match(css, /--panel:\s*#1f2937/i);
    assert.match(css, /--blue:\s*#3b82f6/i);
    assert.match(css, /--yellow:\s*#facc15/i);
    assert.match(css, /font-family:\s*Inter,/i);
    assert.match(css, /min-height:\s*80px/i);
    assert.match(html, /Alpha\s*<em>City<\/em>/);
    assert.match(html, /sluice\.css\?v=6/);
});

test('claim credentials are fragment-only and legacy query keys are immediately scrubbed', () => {
    assert.match(source, /#claim=\$\{encoded\}/);
    assert.match(source, /new URLSearchParams\(location\.hash\.slice\(1\)\)/);
    assert.match(source, /query\.get\('claimKey'\)/);
    assert.match(source, /history\.replaceState\(\{\}, document\.title, location\.pathname\)/);
    assert.doesNotMatch(source, /\?claimKey=\$\{/);
});

test('V1 unsafe controls are disabled while V1 claims remain available', () => {
    assert.match(source, /unsafe V1 cancellation and manual market activation are intentionally disabled/);
    assert.match(source, /schedule\.version === 2[\s\S]*cancelSchedule/);
    assert.match(source, /schedule\.version === 2[\s\S]*sluice_v2::claim_vested[\s\S]*sluice::claim_vested/);
});
