'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/launchpad-core.js');

const ADDRESS = `0x${'1'.repeat(64)}`;
const TREASURY = `0x${'2'.repeat(64)}`;

function project(overrides = {}) {
    return {
        id: 'night-shift',
        name: 'Night Shift',
        creatorName: 'After Dark Studio',
        creatorAddress: ADDRESS,
        description: 'A collection built after midnight.',
        assignmentPolicy: 'sequential-equivalent',
        mediaReleaseVerified: true,
        heroFile: 'hero.png',
        royaltyBps: 500,
        platformFeeBps: 0,
        maxPerTx: 5,
        stages: [{
            name: 'Public Mint', priceSui: '1.25', startTime: '2099-08-01T18:00:00Z',
            endTime: '', walletLimit: 5, allocation: 0,
            allowlistOnly: false, allowlist: [],
        }],
        ...overrides,
    };
}

const csv = [
    'Name,Description,File Name,Reserve For Creator,attributes[Background],attributes[Quote]',
    'Night #1,"A description, with a comma",001.png,false,Blue,"Hello ""City"""',
    'Night #2,Team item,002.png,true,Gold,Reserved',
].join('\n');

const files = [
    { name: 'hero.png', size: 100 },
    { name: '001.png', size: 200 },
    { name: '002.png', size: 300 },
];

test('CSV parser handles quoted commas and doubled quotes', () => {
    const parsed = core.parseCsv(csv);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0].Description, 'A description, with a comma');
    assert.equal(parsed.rows[0]['attributes[Quote]'], 'Hello "City"');
});

test('SUI amounts convert to MIST without floating-point rounding', () => {
    assert.equal(core.suiToMist('1.000000001'), 1_000_000_001n);
    assert.equal(core.suiToMist('0.25'), 250_000_000n);
    assert.equal(core.mistToSui(1_250_000_000n), '1.25');
    assert.throws(() => core.suiToMist('0.0000000001'), /9 decimal places/);
    assert.throws(() => core.suiToMist('-1'), /non-negative decimal/);
});

test('submission validation matches media, traits, and reserved inventory', () => {
    const result = core.validateSubmission(project(), csv, files);
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.equal(result.supply, 2);
    assert.equal(result.publicSupply, 1);
    assert.equal(result.reservedSupply, 1);
    assert.deepEqual(result.items[0].attributes, { Background: 'Blue', Quote: 'Hello "City"' });
});

test('validation rejects missing media and an empty allowlist-only stage', () => {
    const input = project({ stages: [{ name: 'Private', priceSui: '1', startTime: '2026-08-01T18:00:00Z', walletLimit: 1, allowlistOnly: true, allowlist: [] }] });
    const result = core.validateSubmission(input, csv, files.filter((file) => file.name !== '002.png'));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('allowlist-only')));
    assert.ok(result.errors.some((error) => error.includes('002.png')));
});

test('validation cannot report ready before a media folder is supplied', () => {
    const result = core.validateSubmission(project(), csv, []);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('media folder')));
    assert.ok(result.errors.some((error) => error.includes('001.png')));
});

test('prepared launch separates initialization data from public collection config', () => {
    const validation = core.validateSubmission(project(), csv, files);
    const bundle = core.prepareLaunch(validation, {
        platformTreasury: TREASURY,
        mediaBaseUrl: `https://assets.example/night-shift/releases/${'a'.repeat(64)}/media`,
        contract: { packageId: ADDRESS, dropId: TREASURY, module: 'managed_drop', upgradePolicy: 'immutable', displayAuthority: ADDRESS, adminAuthority: ADDRESS },
    });
    assert.equal(bundle.collection.contract.mode, 'managed-drop');
    assert.equal(bundle.collection.heroImage, `https://assets.example/night-shift/releases/${'a'.repeat(64)}/media/hero.png`);
    assert.equal(bundle.initialization.publicItems[0].mediaUrl, `https://assets.example/night-shift/releases/${'a'.repeat(64)}/media/001.png`);
    assert.equal(bundle.initialization.reservedItems[0].name, 'Night #2');
    assert.equal(bundle.initialization.stages[0].priceMist, '1250000000');
    assert.equal(bundle.initialization.expectedStageCount, 1);
    assert.equal(bundle.initialization.expectedAllowlistEntryCount, 0);
    assert.equal(bundle.initialization.assignmentPolicy, 'sequential-equivalent');
    assert.equal(bundle.collection.contract.deploymentManifest.maxPerTx, 5);
});

test('assignment policy, stage capacity, reserve tokens, and exact media casing fail closed', () => {
    const missingPolicy = core.validateSubmission(project({ assignmentPolicy: '' }), csv, files);
    assert.equal(missingPolicy.valid, false);
    assert.ok(missingPolicy.errors.some((error) => error.includes('Assignment policy')));

    const finite = core.validateSubmission(project({ stages: [{
        name: 'Finite', priceSui: '1', startTime: '2099-08-01T18:00:00Z',
        endTime: '', walletLimit: 5, allocation: 0,
        allowlistOnly: false, allowlist: [],
    }] }), csv.replace('002.png,true', '002.png,false'), files);
    assert.equal(finite.valid, true, finite.errors.join('\n'));
    finite.project.stages[0].allocation = 1;
    const underAllocated = core.validateSubmission({ ...project(), stages: [{ ...finite.project.stages[0], allocation: 1 }] }, csv.replace('002.png,true', '002.png,false'), files);
    assert.equal(underAllocated.valid, false);
    assert.ok(underAllocated.errors.some((error) => error.includes('can reach only')));

    const badReserve = core.validateSubmission(project(), csv.replace('002.png,true', '002.png,treu'), files);
    assert.ok(badReserve.errors.some((error) => error.includes('Reserve For Creator')));
    const badCase = core.validateSubmission(project(), csv.replace('001.png', '001.PNG'), files);
    assert.ok(badCase.errors.some((error) => error.includes('exact filename casing on disk')));
});

test('media signatures recognize raster bytes and reject spoofed or SVG intake', () => {
    assert.equal(core.validateMediaSignature('art.png', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).valid, true);
    assert.match(core.validateMediaSignature('art.jpg', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).error, /does not match/);
    assert.match(core.validateMediaSignature('art.svg', Uint8Array.from([0x3c, 0x73, 0x76, 0x67])).error, /unsupported/);
});

test('Sui addresses are normalized to 32 bytes', () => {
    assert.equal(core.normalizeSuiAddress('0x2'), `0x${'0'.repeat(63)}2`);
    assert.equal(core.isValidSuiAddress('not-an-address'), false);
});
