'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/launchpad-core.js');

const ADDRESS = `0x${'1'.repeat(64)}`;
const ZERO = `0x${'0'.repeat(64)}`;
const BASE_CSV = [
    'Name,Description,File Name,Reserve For Creator',
    'Alpha #1,First,001.png,false',
    'Alpha #2,Second,002.png,true',
].join('\n');
const FILES = [
    { name: 'hero.png', size: 100 },
    { name: '001.png', size: 100 },
    { name: '002.png', size: 100 },
];

function project(overrides = {}) {
    return {
        id: 'alpha',
        name: 'Alpha',
        description: 'Alpha collection description.',
        assignmentPolicy: 'sequential-equivalent',
        mediaReleaseVerified: true,
        creatorAddress: ADDRESS,
        intendedSupply: 2,
        heroFile: 'hero.png',
        stages: [{
            name: 'Public',
            priceSui: '1',
            startTime: '2099-09-01T18:00:00Z',
            endTime: '',
            walletLimit: 2,
            allowlistOnly: false,
            allowlist: [],
        }],
        ...overrides,
    };
}

test('first-party defaults use schema v3 and no platform fee', () => {
    const result = core.validateSubmission(project(), BASE_CSV, FILES);
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.equal(result.project.schemaVersion, 3);
    assert.equal(result.project.platformFeeBps, 0);
    assert.equal(result.project.intendedSupply, 2);
});

test('normalized stage timestamps survive a second normalization', () => {
    const once = core.normalizeProject(project());
    assert.equal(once.errors.length, 0, once.errors.join('\n'));
    const twice = core.normalizeProject(once.value);
    assert.equal(twice.errors.length, 0, twice.errors.join('\n'));
    assert.equal(twice.value.stages[0].startTimeMs, Date.parse('2099-09-01T18:00:00Z'));
    assert.equal(twice.value.stages[0].endTimeMs, 0);
});

test('contract-incompatible payout and inventory fail before preparation', () => {
    const zeroPayout = core.validateSubmission(project({ creatorAddress: ZERO }), BASE_CSV, FILES);
    assert.equal(zeroPayout.valid, false);
    assert.ok(zeroPayout.errors.some((error) => error.includes('nonzero')));

    const allReservedCsv = BASE_CSV.replace('001.png,false', '001.png,true');
    const allReserved = core.validateSubmission(project(), allReservedCsv, FILES);
    assert.equal(allReserved.valid, false);
    assert.ok(allReserved.errors.some((error) => error.includes('public minting')));
});

test('duplicate allowlist addresses, overlapping phases, and empty media are rejected', () => {
    const result = core.validateSubmission(project({
        stages: [
            {
                name: 'Allowlist', priceSui: '0.5', startTime: '2099-09-01T18:00:00Z',
                endTime: '2099-09-03T18:00:00Z', walletLimit: 2, allowlistOnly: true,
                allowlist: [ADDRESS, ADDRESS],
            },
            {
                name: 'Public', priceSui: '1', startTime: '2099-09-02T18:00:00Z',
                endTime: '2099-09-04T18:00:00Z', walletLimit: 2, allowlistOnly: false, allowlist: [],
            },
        ],
    }), BASE_CSV, FILES.map((file) => file.name === '002.png' ? { ...file, size: 0 } : file));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('duplicate allowlist')));
    assert.ok(result.errors.some((error) => error.includes('overlap')));
    assert.ok(result.errors.some((error) => error.includes('002.png is empty')));
});

test('intended supply must match metadata rows', () => {
    const result = core.validateSubmission(project({ intendedSupply: 3 }), BASE_CSV, FILES);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('does not match')));
});

test('prepared public media URLs reject Google Drive and embedded credentials', () => {
    const validation = core.validateSubmission(project(), BASE_CSV, FILES);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.throws(() => core.prepareLaunch(validation, {
        mediaBaseUrl: 'https://drive.google.com/alpha',
        platformTreasury: ADDRESS,
    }), /source backups/);
    assert.throws(() => core.prepareLaunch(validation, {
        mediaBaseUrl: 'https://user:secret@media.alphacity.tech/alpha',
        platformTreasury: ADDRESS,
    }), /credentials/);
});

test('media URL validation rejects query strings, fragments, and Google hosts', () => {
    assert.equal(core.validateMediaBaseUrl('https://media.alphacity.tech/releases/citizens/hash').valid, true);
    assert.equal(core.validateMediaBaseUrl(`https://media.alphacity.tech/alpha/releases/${'a'.repeat(64)}/media`, { requireReleasePath: true, collectionId: 'alpha' }).valid, true);
    assert.match(core.validateMediaBaseUrl('https://media.alphacity.tech/alpha/latest', { requireReleasePath: true, collectionId: 'alpha' }).error, /content-hashed R2 release/);
    assert.match(core.validateMediaBaseUrl('https://media.alphacity.tech/release?token=1').error, /query string/);
    assert.match(core.validateMediaBaseUrl('https://lh3.googleusercontent.com/image').error, /Google-hosted/);
});

test('allowlist reachability, normalized traits, first-party fee, and media attestation fail closed', () => {
    assert.ok(core.normalizeProject(project({ stages: [{
        name: 'Missing start', priceSui: '1', walletLimit: 1, allocation: 0, allowlistOnly: false, allowlist: [],
    }] })).errors.some((error) => error.includes('start time is required')));
    assert.ok(core.normalizeProject(project({ stages: [{
        name: 'Finite final', priceSui: '1', startTime: '2099-09-01T18:00:00Z', endTime: '2099-09-02T18:00:00Z',
        walletLimit: 1, allocation: 2, allowlistOnly: false, allowlist: [],
    }] })).errors.some((error) => error.includes('unsold supply')));
    assert.ok(core.normalizeProject(project({ stages: [{
        name: 'Ambiguous', priceSui: '1', startTime: '2099-09-01T18:00:00Z', walletLimit: 1,
        allocation: 0, allowlistOnly: 'false', allowlist: [{ address: ADDRESS, limit: 1 }],
    }] })).errors.some((error) => error.includes('explicit boolean')));
    const allPublic = BASE_CSV.replace('002.png,true', '002.png,false');
    const unreachable = core.validateSubmission(project({ stages: [{
        name: 'Allowlist', priceSui: '1', startTime: '2099-09-01T18:00:00Z',
        endTime: '2099-09-02T18:00:00Z', walletLimit: 1, allocation: 0,
        allowlistOnly: true, allowlist: [{ address: ADDRESS, limit: 1 }],
    }] }), allPublic, FILES);
    assert.ok(unreachable.errors.some((error) => error.includes('can reach only')));

    const duplicateTraits = core.validateSubmission(project(), [
        'Name,Description,File Name,Reserve For Creator,attributes[Type],attributes[ Type ]',
        'Alpha #1,First,001.png,false,A,B',
        'Alpha #2,Second,002.png,true,A,B',
    ].join('\n'), FILES);
    assert.ok(duplicateTraits.errors.some((error) => error.includes('duplicate normalized trait')));

    assert.ok(core.normalizeProject(project({ platformFeeBps: 1 })).errors.some((error) => error.includes('0% platform fee')));
    const unverified = core.validateSubmission(project({ mediaReleaseVerified: false }), BASE_CSV, FILES);
    assert.equal(unverified.valid, true);
    assert.throws(() => core.prepareLaunch(unverified, {
        mediaBaseUrl: `https://media.alphacity.tech/alpha/releases/${'a'.repeat(64)}/media`,
        platformTreasury: ADDRESS,
    }), /R2 manifest/);
    assert.equal(core.normalizeProject(project({ mediaReleaseVerified: 'false' })).value.mediaReleaseVerified, false);
    assert.ok(core.normalizeProject(project({ reveal: { mode: 'mystery' } })).errors.some((error) => error.includes('Reveal mode')));
    const delayed = core.validateSubmission(project({ reveal: { mode: 'delayed' } }), BASE_CSV, FILES);
    assert.throws(() => core.prepareLaunch(delayed, {
        mediaBaseUrl: `https://media.alphacity.tech/alpha/releases/${'a'.repeat(64)}/media`,
        platformTreasury: ADDRESS,
    }), /delayed reveal/i);
});

test('slug, duplicate headers, reserve typos, and u64 payment overflow are rejected', () => {
    const badSlug = core.validateSubmission(project({ id: 'Alpha Citizens' }), BASE_CSV, FILES);
    assert.ok(badSlug.errors.some((error) => error.includes('already be normalized')));
    const duplicate = core.validateSubmission(project(), `${BASE_CSV.split('\n')[0]},Reserve For Creator\nAlpha #1,First,001.png,false,true`, FILES);
    assert.ok(duplicate.errors.some((error) => error.includes('duplicate header')));
    const typo = core.validateSubmission(project(), BASE_CSV.replace('002.png,true', '002.png,reserved'), FILES);
    assert.ok(typo.errors.some((error) => error.includes('Reserve For Creator')));
    const overflow = core.normalizeProject(project({ stages: [{
        name: 'Overflow', priceSui: '18446744073.709551615', startTime: '2099-09-01T18:00:00Z',
        endTime: '2099-09-02T18:00:00Z', walletLimit: 2, allocation: 0, allowlistOnly: false, allowlist: [],
    }], maxPerTx: 2 }));
    assert.ok(overflow.errors.some((error) => error.includes('multiplied by the maximum')));
});
