'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts', 'launchpad-project.cjs');
const address = `0x${'a'.repeat(64)}`;
const treasury = `0x${'b'.repeat(64)}`;

test('prepare command emits a reproducible package, config, and transaction batches', (context) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'alphacity-launch-'));
    context.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const media = path.join(temp, 'media');
    fs.mkdirSync(media);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    fs.writeFileSync(path.join(media, 'hero.png'), png);
    fs.writeFileSync(path.join(media, '001.png'), png);
    fs.writeFileSync(path.join(media, '002.png'), png);
    fs.writeFileSync(path.join(temp, 'metadata.csv'), [
        'Name,Description,File Name,Reserve For Creator,attributes[Type]',
        'One,First,001.png,false,Public',
        'Two,Second,002.png,true,Reserved',
    ].join('\n'));
    fs.writeFileSync(path.join(temp, 'project.json'), JSON.stringify({
        id: 'cli-test', name: 'CLI Test', description: 'CLI preparation test.', creatorAddress: address, heroFile: 'hero.png',
        assignmentPolicy: 'sequential-equivalent',
        mediaReleaseVerified: true,
        platformFeeBps: 0, royaltyBps: 250, maxPerTx: 3,
        stages: [{ name: 'Public', priceSui: '2', startTime: '2099-08-01T00:00:00Z', walletLimit: 3, allowlistOnly: false }],
    }));
    const output = path.join(temp, 'output');
    const mediaBaseUrl = `https://media.example/cli-test/releases/${'c'.repeat(64)}/media`;
    const stdout = execFileSync(process.execPath, [cli, 'prepare', temp, '--treasury', treasury, '--media-base-url', mediaBaseUrl, '--out', output], { encoding: 'utf8' });
    assert.match(stdout, /VALID: 2 items/);
    assert.match(stdout, /No package was published/);
    const collection = JSON.parse(fs.readFileSync(path.join(output, 'collection.json'), 'utf8'));
    const transactions = JSON.parse(fs.readFileSync(path.join(output, 'transactions.json'), 'utf8'));
    const moveSource = fs.readFileSync(path.join(output, 'contract', 'sources', 'managed_drop.move'), 'utf8');
    assert.equal(collection.contract.mode, 'coming-soon');
    assert.equal(transactions.inventoryBatches.length, 1);
    assert.equal(transactions.inventoryBatches[0].length, 2);
    assert.equal(transactions.createDrop.target, '${PACKAGE_ID}::managed_drop::create_drop');
    assert.equal(transactions.createDrop.arguments[0].value, '${LAUNCH_CAP_ID}');
    assert.equal(transactions.version, 2);
    assert.equal(transactions.reconciliation.expectedStageCount, 1);
    assert.equal(transactions.releaseGate.immutable.target, '0x2::package::make_immutable');
    assert.equal(transactions.releaseGate.display.object, '${DISPLAY_CAP_ID}');
    assert.equal(transactions.releaseGate.admin.object, '${ADMIN_CAP_ID}');
    assert.equal(transactions.publishDrop.arguments[2].value, '0x6');
    assert.match(moveSource, /module cli_test::managed_drop/);
    assert.equal(fs.existsSync(path.join(output, 'contract', 'tests')), false);
});
