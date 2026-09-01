'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'launchpad', 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'launchpad', 'operator-app.js'), 'utf8');

test('launchpad is a six-step first-party builder and legacy public links move to mint', () => {
    for (const label of ['Collection', 'Items', 'Mint phases', 'Payouts', 'Review', 'Prepare']) assert.match(page, new RegExp(label));
    assert.match(page, /AlphaCity collection only/);
    assert.match(page, /target = new URL\('\/mint\/'/);
    assert.match(page, /params\.get\('mode'\) !== 'edit'/);
    assert.match(page, /\/launchpad\/operator-app\.js/);
    assert.match(page, /\/launchpad\/tailwind\.css/);
    assert.doesNotMatch(page, /cdn\.tailwindcss\.com/);
});

test('builder saves locally and keeps media and signing credentials out of browser persistence', () => {
    assert.match(source, /indexedDB\.open/);
    assert.match(source, /localStorage\.setItem/);
    assert.doesNotMatch(source, /mediaFiles:\s*state\.mediaFiles/);
    assert.doesNotMatch(source, /csvText:\s*state\.csvText/);
    assert.doesNotMatch(source, /csvName:\s*state\.csvName/);
    assert.match(source, /state\.resetting = true/);
    assert.match(source, /if \(!state\.loaded \|\| state\.resetting\) return/);
    assert.match(page, /Files stay in this tab and are never uploaded by this page/);
    assert.doesNotMatch(page + source, /type="password"/);
    assert.doesNotMatch(page + source, /privateKey|seedPhrase|apiToken/);
});

test('builder supports phase CRUD, allowlist imports, exact royalties, validation, preview, and exports', () => {
    assert.match(source, /function exactPercentToBps/);
    assert.match(source, /function parseAllowlist/);
    assert.match(source, /data-phase-action/);
    assert.match(source, /core\.validateSubmission/);
    assert.match(source, /state\.validation = \{ \.\.\.result, errors: itemErrors/);
    assert.match(source, /core\.prepareLaunch/);
    assert.match(source, /platformFeeBps:\s*0/);
    assert.match(source, /core\.validateMediaBaseUrl/);
    assert.match(source, /requireMediaSignatures: true/);
    assert.match(source, /file\.slice\(0, 16\)\.arrayBuffer/);
    assert.match(source, /assignment-policy-equivalent/);
    assert.match(source, /\['collection-name', 'collection-slug', 'hero-file'\]\.includes\(element\.id\)/);
    assert.match(page, /equivalent mint value/);
    assert.match(page, /external R2 release gate/i);
    assert.match(page, /id="preview-name"/);
    assert.match(page, /Delayed reveal \(future contract\)/);
});

test('builder source parses as JavaScript', () => {
    assert.doesNotThrow(() => new Function(source));
});
