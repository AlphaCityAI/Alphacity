'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'merch', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'merch', 'merch.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'merch', 'merch.css'), 'utf8');
const catalogSource = fs.readFileSync(path.join(root, 'merch', 'catalog.js'), 'utf8');
const homepage = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadCatalog() {
    const context = { window: {} };
    vm.runInNewContext(catalogSource, context);
    return context.window.AlphaCityMerchCatalog;
}

test('merch page uses the shared Alpha City wallet session', () => {
    const syncIndex = html.indexOf('/shared/wallet-sync.js');
    const connectorIndex = html.indexOf('/shared/wallet-connector.js');
    const appIndex = html.indexOf('/merch/merch.js');

    assert.ok(syncIndex > -1);
    assert.ok(connectorIndex > syncIndex);
    assert.ok(appIndex > connectorIndex);
    assert.match(source, /AlphaCityWalletConnector\.create/);
    assert.match(html, /id="connect-wallet-btn"/);
});

test('preview catalog is complete and becomes shoppable through configuration', () => {
    const catalog = loadCatalog();

    assert.equal(catalog.platform, 'Fourthwall');
    assert.equal(catalog.status, 'preview');
    assert.equal(catalog.shopUrl, '');
    assert.equal(catalog.products.length, 6);
    assert.deepEqual(
        [...new Set(Array.from(catalog.products, (product) => product.category))].sort(),
        ['accessories', 'apparel', 'home'],
    );
    assert.ok(catalog.products.every((product) => product.id && product.name && product.mock));
    assert.match(source, /product\.url \? 'a' : 'span'/);
    assert.match(source, /setupShopLinks/);
});

test('merch page includes launch metadata, responsive styles, and reduced-motion support', () => {
    assert.match(html, /<link rel="canonical" href="https:\/\/alphacity\.tech\/merch\/">/);
    assert.match(html, /https:\/\/alphacity\.tech\/merch\/og\.png/);
    assert.match(html, /id="catalog-filters"/);
    assert.match(html, /id="faq"/);
    assert.match(css, /--blue:\s*#3b82f6/i);
    assert.match(css, /--gold:\s*#facc15/i);
    assert.match(css, /@media \(max-width:\s*680px\)/);
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('social card is a valid wide PNG and homepage links to merch', () => {
    const image = fs.readFileSync(path.join(root, 'merch', 'og.png'));
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);

    assert.deepEqual(image.subarray(0, 8), pngSignature);
    assert.ok(width / height > 1.8);
    assert.equal((homepage.match(/href="\/merch\/"/g) || []).length, 2);
});
