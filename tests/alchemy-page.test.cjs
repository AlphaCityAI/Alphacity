const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'alchemy', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'alchemy', 'app-source.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'alchemy', 'app.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Alchemy page loads shared wallet and Sui dependencies before its app', () => {
    const scripts = [
        '/shared/wallet-sync.js',
        '/shared/wallet-connector.js',
        '/shared/sui-client.js',
        '/shared/alchemy-core.js',
        '/alchemy/app.js',
    ];
    let previous = -1;
    for (const script of scripts) {
        const index = html.indexOf(`src="${script}"`);
        assert.ok(index > previous, `${script} should load in dependency order`);
        previous = index;
    }
});

test('Alchemy uses the universal wallet connector and excludes a homepage launch change', () => {
    assert.match(source, /AlphaCityWalletConnector\.create/);
    assert.match(source, /signAndExecuteTransaction\(state\.prepared\.tx\)/);
    const homepage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.doesNotMatch(homepage, /href=["']\/alchemy\/?["']/i);
});

test('Alchemy composes, simulates, and only then enables execution', () => {
    assert.match(source, /addTransactionForCompleteTradeRoute/);
    assert.match(source, /mergeCoins\(cityCoins\[0\]/);
    assert.match(source, /simulateTransaction/);
    assert.match(source, /include:\s*\{\s*effects:\s*true,\s*balanceChanges:\s*true/);
    assert.ok(source.indexOf('simulateTransaction') < source.indexOf("$('confirm-button').disabled = false"));
});

test('Alchemy UI discloses its conservative eligibility and batch behavior', () => {
    assert.match(html, /fresh executable value below \$1/i);
    assert.match(html, /Only verified, routable balances below \$1 can be selected/i);
    assert.match(html, /up to 6 token types in one atomic transaction/i);
    assert.match(html, /No funds move until your wallet approves/i);
});

test('Alchemy build output and package script are present', () => {
    assert.ok(bundle.length > 10_000, 'Alchemy browser bundle should not be empty');
    assert.match(packageJson.scripts['build:alchemy'], /alchemy\/app-source\.js/);
    assert.match(packageJson.scripts.build, /build:alchemy/);
    assert.equal(packageJson.dependencies['aftermath-ts-sdk'], '^2.1.0');
});
