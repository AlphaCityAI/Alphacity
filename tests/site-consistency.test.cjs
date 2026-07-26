'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

const sharedConnectorPages = [
    'tools/index.html',
    'intel/index.html',
    'airdrop/index.html',
    'swap/index.html',
    'mint/index.html',
    'secrets/index.html',
    'alchemy/index.html',
    'pay/index.html',
    'predict/index.html',
    'sluice/index.html',
    'launchpad/index.html',
    'launchpad/operator/index.html',
];

test('every non-staking wallet surface uses the same connector without a page-local adapter', () => {
    for (const relative of sharedConnectorPages) {
        const page = read(relative);
        assert.match(page, /\/shared\/wallet-connector\.js/, `${relative} should load the shared connector`);
        assert.doesNotMatch(page, /function discoverWallets|class WalletStandard(?:AppReady)?Event/, `${relative} should not duplicate wallet discovery`);
    }
});

test('staking retains shared persistence and exposes only the canonical Phantom label', () => {
    const page = read('staking/index.html');
    const bundle = read('assets/index-BymD0MH7.js');
    assert.match(page, /\/shared\/wallet-sync\.js/);
    assert.doesNotMatch(bundle, /Phantom \(Sui\)/);
    assert.match(bundle, /window\.phantom\?\.sui&&n\(r\(window\.phantom\.sui,"Phantom"/);
});

test('all gated tool headers link back to the Tools Portal with the same label', () => {
    for (const relative of ['intel/index.html', 'airdrop/index.html', 'pay/index.html', 'sluice/index.html']) {
        const page = read(relative);
        assert.match(page, /href="\/tools\/"[^>]*>[\s\S]{0,120}Tools Portal/, `${relative} should expose Tools Portal navigation`);
    }
});

test('same-page wallet changes immediately recheck the CITY tools gate', () => {
    const gate = read('shared/tools-gate.js');
    const sync = read('shared/wallet-sync.js');
    assert.match(gate, /addEventListener\('alphacity-wallet-change', checkWalletSession\)/);
    assert.match(sync, /new CustomEvent\('alphacity-wallet-change'/);
});
