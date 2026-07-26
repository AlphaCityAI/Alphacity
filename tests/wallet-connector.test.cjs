'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'shared', 'wallet-connector.js'), 'utf8');

test('shared wallet connector exposes provider, account, and disconnect options', () => {
    assert.match(source, /Switch Account/);
    assert.match(source, /Switch Wallet Provider/);
    assert.match(source, /Disconnect/);
});

test('shared wallet connector signs through modern and legacy Sui wallet features', () => {
    assert.match(source, /sui:signAndExecuteTransaction/);
    assert.match(source, /sui:signAndExecuteTransactionBlock/);
    assert.match(source, /signAndExecuteTransaction,/);
    assert.match(source, /selectedAccount\s*=\s*availableAccounts\.find/);
});

test('Phantom is presented once while its Sui-specific provider remains available', () => {
    assert.match(source, /legacyAdapter\(root\.phantom\.sui, 'Phantom'\)/);
    assert.match(source, /canonicalWalletName/);
    assert.doesNotMatch(source, /Phantom \(Sui\)/);
});

test('Slush manual switching forces the wallet-native selector instead of a one-account dead end', () => {
    assert.match(source, /forceFreshConnect = walletKey\(name\)\.includes\('slush'\)/);
    assert.match(source, /if \(!silent && forceFreshConnect && disconnectFeature\?\.disconnect\)/);
    assert.match(source, /if \(currentAdapter\.forceFreshConnect\)/);
    assert.match(source, /await currentAdapter\.connect\(\{ silent: false \}\)/);
});

test('shared sessions retry late wallet registration and react within the current page', () => {
    assert.match(source, /registryListeners/);
    assert.match(source, /alphacity-wallet-change/);
    assert.match(source, /const delays = \[0, 600, 1500, 3500, 7000\]/);
    assert.match(source, /window\.addEventListener\('storage', handleStorage\)/);
});
