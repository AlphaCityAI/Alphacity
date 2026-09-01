'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'mint', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'mint', 'app-source.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'mint', 'app.js'), 'utf8');
const citizens = JSON.parse(fs.readFileSync(path.join(root, 'launchpad', 'collections', 'citizens', 'collection.json'), 'utf8'));

test('mint route uses the managed-drop UI and shared wallet infrastructure', () => {
    assert.match(page, /id="phase-list"/);
    assert.match(page, /id="gallery-grid"/);
    assert.match(page, /id="detail-grid"/);
    assert.match(page, /\/shared\/wallet-connector\.js/);
    assert.match(page, /\/shared\/sui-client\.js/);
    assert.match(page, /\/shared\/launchpad-core\.js/);
    assert.match(page, /\/mint\/app\.js/);
    assert.match(page, /\/launchpad\/tailwind\.css/);
    assert.doesNotMatch(page, /cdn\.tailwindcss\.com/);
    assert.doesNotMatch(page, /Minting for this collection is not live yet[\s\S]*addEventListener/);
    assert.ok(bundle.length > 1_000, 'mint browser bundle should be generated');
});

test('mint route loads the launchpad registry and preserves collection selection', () => {
    assert.match(source, /REGISTRY_URL = '\/launchpad\/collections\/index\.json'/);
    assert.match(source, /URLSearchParams\(window\.location\.search\)\.get\('collection'\)/);
    assert.match(source, /url\.searchParams\.set\('collection', entry\.id\)/);
    assert.match(source, /history\.replaceState/);
    assert.match(source, /Collection “\$\{id\}” is not listed for minting/);
});

test('mint transactions require a complete managed-drop contract configuration', () => {
    assert.match(source, /function configuredContract\(\)/);
  assert.match(source, /nonzeroSuiAddress\(contract\?\.packageId\)/);
  assert.match(source, /nonzeroSuiAddress\(contract\?\.dropId\)/);
    assert.match(source, /configured drop object does not match this collection contract/);
    assert.match(source, /deploymentManifest/);
    assert.match(source, /assertDropMatchesManifest/);
    assert.match(source, /collectionMatchesDeploymentManifest/);
    assert.match(source, /manifest\.stages/);
    assert.match(source, /upgradePolicy/);
    assert.match(source, /displayAuthority/);
    assert.match(source, /if \(state\.busy \|\| !state\.wallet\?\.address \|\| !state\.activeStage \|\| !configuredContract\(\)\) return/);
    assert.match(source, /new Transaction\(\)/);
    assert.match(source, /signAndExecuteTransaction\(transaction\)/);
});

test('mint route refreshes on-chain state and prechecks stage allowance', () => {
    assert.match(source, /async function refreshLiveState\(\)/);
    assert.match(source, /await refreshOnchain\(\)/);
    assert.match(source, /window\.setInterval\([\s\S]*refreshLiveState\(\)/);
    assert.match(source, /getDynamicField/);
    assert.match(source, /WalletMintKey/);
    assert.match(source, /AllowlistKey/);
    assert.match(source, /remaining for this wallet in this stage/);
    assert.match(source, /on-chain wallet allowance must be verified/);
    assert.match(source, /assertCurrentMintSnapshot/);
    assert.match(source, /onchainReadEpoch/);
    assert.match(source, /maxQuantityFor\(onchain, stage, eligibility, null\)/);
    assert.match(source, /Mint submitted, but confirmation is uncertain/);
    assert.match(page, /id="mint-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('Citizens remains non-transactional until its contract is published', () => {
    assert.equal(citizens.contract.mode, 'coming-soon');
    assert.equal(citizens.contract.packageId, undefined);
    assert.equal(citizens.contract.dropId, undefined);
});
