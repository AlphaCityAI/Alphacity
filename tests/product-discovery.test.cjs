'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Tools is a public catalog with truthful access labels', () => {
    const page = read('tools/index.html');
    assert.match(page, /id="tools-catalog"/);
    assert.match(page, /Browse the complete catalog without connecting/);
    assert.match(page, /href="\/alchemy\/"[^>]*data-telemetry-tool="alchemy"[^>]*data-telemetry-access="free"/);
    assert.match(page, /Free · No CITY gate/);
    assert.match(page, /href="\/launchpad\/"[^>]*data-telemetry-access="public"/);
    assert.match(page, /Public claims · Premium creation/);
    for (const route of ['/intel/', '/airdrop/', '/pay/', '/staking/', '/sluice/', '/swap/']) {
        assert.match(page, new RegExp(`href="${route.replaceAll('/', '\\/')}"`), `${route} should appear in the catalog`);
    }
    assert.match(page, /safeInternalRedirect/);
    assert.match(page, /target\.origin !== window\.location\.origin/);
});

test('Alchemy is explicitly free and links back to the Tools Portal', () => {
    const page = read('alchemy/index.html');
    assert.match(page, /Free utility · No \$CITY ownership required/);
    assert.match(page, /href="\/tools\/"[^>]*data-telemetry-action="return_to_tools"/);
    assert.doesNotMatch(page, /\/shared\/tools-gate\.js/);
});
