'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('homepage leads with working products and accessible primary actions', () => {
    const page = read('index.html');
    assert.match(page, /One wallet\. A whole city of <span[^>]*>Sui tools\.<\/span>/);
    assert.match(page, /href="\/tools\/"[^>]*data-telemetry-action="explore_tools"/);
    assert.match(page, /id="products"/);
    assert.match(page, /href="\/alchemy\/"[^>]*data-telemetry-access="free"/);
    assert.match(page, /href="\/launchpad\/"[^>]*data-telemetry-access="public"/);
    assert.match(page, /aria-controls="mobile-menu" aria-expanded="false"/);
    assert.match(page, /setAttribute\('aria-expanded', String\(open\)\)/);
    assert.doesNotMatch(page, /Placeholder for art|entry-level utilty|technology, utiity|Holders of 5m\+/i);
});

test('homepage publishes complete social metadata and a project-local image', () => {
    const page = read('index.html');
    assert.match(page, /property="og:image" content="https:\/\/alphacity\.tech\/assets\/alpha-city-og\.png"/);
    assert.match(page, /name="twitter:card" content="summary_large_image"/);
    const image = fs.readFileSync(path.join(root, 'assets', 'alpha-city-og.png'));
    assert.ok(image.length > 100_000, 'social image should be a substantive raster asset');
    assert.equal(image.subarray(1, 4).toString('ascii'), 'PNG');
});

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
