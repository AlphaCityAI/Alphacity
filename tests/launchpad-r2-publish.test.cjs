'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const publisher = require('../scripts/launchpad-r2-publish.cjs');

const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'scripts', 'launchpad-r2-publish.cjs');
const address = `0x${'a'.repeat(64)}`;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(payload) {
    return Buffer.concat([PNG_SIGNATURE, Buffer.from(payload)]);
}

function makeProject(context) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alphacity-r2-test-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const media = path.join(directory, 'media');
    fs.mkdirSync(media);
    fs.writeFileSync(path.join(media, 'hero image.png'), pngBytes('hero-image'));
    fs.writeFileSync(path.join(media, '001 art.png'), pngBytes('first-nft'));
    fs.writeFileSync(path.join(media, 'unused.png'), pngBytes('do-not-publish'));
    fs.writeFileSync(path.join(directory, 'metadata.csv'), [
        'Name,Description,File Name,Reserve For Creator,attributes[Type]',
        'Citizen One,First Citizen,001 art.png,false,Genesis',
    ].join('\n'));
    fs.writeFileSync(path.join(directory, 'project.json'), JSON.stringify({
        schemaVersion: 3,
        id: 'our-collection',
        name: 'Our Collection',
        description: 'Canonical first-party R2 publication fixture.',
        creatorAddress: address,
        heroFile: 'hero image.png',
        platformFeeBps: 0,
        royaltyBps: 500,
        maxPerTx: 5,
        assignmentPolicy: 'sequential-equivalent',
        stages: [{
            name: 'Public',
            priceSui: '1',
            startTime: '2099-09-01T00:00:00Z',
            walletLimit: 5,
            allowlistOnly: false,
        }],
    }));
    return directory;
}

test('dry-run staging is deterministic, content-addressed, and compatible with mediaBaseUrl', async (context) => {
    const project = makeProject(context);
    const output = path.join(project, 'staged');
    const config = {
        inputDirectory: project,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
        outputDirectory: output,
    };
    const first = await publisher.stagePublication(config);
    const second = await publisher.stagePublication(config);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.match(first.manifest.releaseId, /^[0-9a-f]{64}$/);
    assert.equal(first.manifest.files.length, 2, 'unreferenced media is not published');
    assert.match(first.manifest.mediaBaseUrl, new RegExp(`/collections/our-collection/releases/${first.manifest.releaseId}/media$`));
    assert.equal(first.manifest.files.find((file) => file.name === '001 art.png').url,
        `${first.manifest.mediaBaseUrl}/001%20art.png`);
    assert.equal(first.manifest.heroUrl, `${first.manifest.mediaBaseUrl}/hero%20image.png`);
    assert.equal(first.manifest.files.some((file) => Object.hasOwn(file, 'sourcePath')), false);

    const planText = fs.readFileSync(path.join(output, 'r2-upload-plan.json'), 'utf8');
    assert.equal(planText.includes(project), false, 'plan does not leak absolute local paths');
    const mediaObject = first.plan.objects.find((object) => object.key.endsWith('/001 art.png'));
    assert.equal(await publisher.sha256File(path.join(output, ...mediaObject.source.split('/'))), mediaObject.sha256);
});

test('release changes when media changes and an altered stage is never overwritten', async (context) => {
    const project = makeProject(context);
    const firstOutput = path.join(project, 'first-stage');
    const base = {
        inputDirectory: project,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
    };
    const first = await publisher.stagePublication({ ...base, outputDirectory: firstOutput });
    fs.writeFileSync(path.join(project, 'media', '001 art.png'), pngBytes('changed-nft'));
    const changed = await publisher.buildPublication({ ...base, outputDirectory: path.join(project, 'changed-stage') });
    assert.notEqual(changed.manifest.releaseId, first.manifest.releaseId);

    const stagedMedia = first.plan.objects.find((object) => object.key.endsWith('/001 art.png'));
    fs.writeFileSync(path.join(firstOutput, ...stagedMedia.source.split('/')), 'tampered-stage');
    await assert.rejects(() => publisher.stagePublication({ ...base, outputDirectory: firstOutput }), /different content|changed/);
});

test('prepared directory is checked against its parent source project', async (context) => {
    const project = makeProject(context);
    const prepared = path.join(project, 'prepared');
    fs.mkdirSync(prepared);
    const bundle = {
        collection: { id: 'our-collection', supply: 1 },
        initialization: {
            publicItems: [{
                index: 0,
                name: 'Citizen One',
                description: 'First Citizen',
                fileName: '001 art.png',
                reserved: false,
                attributes: { Type: 'Genesis' },
            }],
            reservedItems: [],
        },
    };
    fs.writeFileSync(path.join(prepared, 'launch-bundle.json'), JSON.stringify(bundle));
    const publication = await publisher.buildPublication({
        inputDirectory: prepared,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
        outputDirectory: path.join(project, 'prepared-stage'),
    });
    assert.equal(publication.manifest.collectionId, 'our-collection');

    bundle.initialization.publicItems[0].fileName = 'stale.png';
    fs.writeFileSync(path.join(prepared, 'launch-bundle.json'), JSON.stringify(bundle));
    await assert.rejects(() => publisher.buildPublication({
        inputDirectory: prepared,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
        outputDirectory: path.join(project, 'stale-stage'),
    }), /inventory does not exactly match/);
});

test('public URL and CLI parsing fail closed without echoing credentials', () => {
    assert.throws(() => publisher.normalizePublicBaseUrl('https://drive.google.com/file/d/example'), /private source or backup/);
    assert.throws(() => publisher.normalizePublicBaseUrl('https://lh3.googleusercontent.com/example'), /private source or backup/);
    assert.throws(() => publisher.normalizePublicBaseUrl('https://media.alphacity.tech/nft'), /without credentials, a path/);
    assert.equal(publisher.normalizePublicBaseUrl('https://media.alphacity.tech/'), 'https://media.alphacity.tech');
    const secret = 'do-not-print-this-token';
    assert.throws(
        () => publisher.parseArgs(['project', '--api-token', secret], {}),
        (error) => /Credential flags are not accepted/.test(error.message) && !error.message.includes(secret),
    );
    assert.throws(
        () => publisher.parseArgs(['project', '--wrangler-js', 'C:\\tools\\wrangler.cmd'], {}),
        /\.cmd\/\.bat wrappers are not accepted/,
    );
    assert.equal(publisher.isMissingObjectResult({ status: 1, stderr: 'The specified key does not exist.' }), true);
    assert.equal(publisher.isMissingObjectResult({ status: 1, stderr: 'NoSuchKey' }), true);
    assert.equal(publisher.isMissingObjectResult({ status: 1, stderr: 'Account does not exist.' }), false);
    assert.equal(publisher.isMissingObjectResult({ status: 1, stderr: 'Configuration file not found (404)' }), false);
});

test('media references must match exact on-disk filename casing', async (context) => {
    const project = makeProject(context);
    fs.writeFileSync(path.join(project, 'metadata.csv'), [
        'Name,Description,File Name,Reserve For Creator,attributes[Type]',
        'Citizen One,First Citizen,001 ART.png,false,Genesis',
    ].join('\n'));
    await assert.rejects(() => publisher.buildPublication({
        inputDirectory: project,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
    }), /exact filename casing on disk: media\/001 art\.png/);
});

test('only raster signatures are staged and extensions must match bytes', async (context) => {
    assert.equal(publisher.detectRasterType(PNG_SIGNATURE), 'png');
    assert.equal(publisher.detectRasterType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
    assert.equal(publisher.detectRasterType(Buffer.from('GIF89a', 'ascii')), 'gif');
    assert.equal(publisher.detectRasterType(Buffer.concat([
        Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii'),
    ])), 'webp');
    assert.equal(publisher.detectRasterType(Buffer.from('<svg>', 'utf8')), '');

    const mismatch = makeProject(context);
    fs.writeFileSync(path.join(mismatch, 'media', '001 art.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    await assert.rejects(() => publisher.buildPublication({
        inputDirectory: mismatch,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
    }), /\.png extension but its file signature is JPEG/);

    const disguised = makeProject(context);
    fs.writeFileSync(path.join(disguised, 'media', '001 art.png'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await assert.rejects(() => publisher.buildPublication({
        inputDirectory: disguised,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
    }), /does not contain a recognized PNG, JPEG, WEBP, or GIF file signature/);

    const active = makeProject(context);
    const svgPath = path.join(active, 'media', 'active.svg');
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    assert.throws(
        () => publisher.validateRasterFile({ name: 'active.svg', sourcePath: svgPath }),
        /SVG.*Active\/vector formats are not permitted/,
    );
    assert.throws(
        () => publisher.validateRasterFile({ name: 'legacy.bmp', sourcePath: svgPath }),
        /unsupported public media format/,
    );
});

test('upload uses argument arrays, resumes identical objects, and blocks different remote content', async (context) => {
    const project = makeProject(context);
    const publication = await publisher.stagePublication({
        inputDirectory: project,
        bucket: 'alphacity-media',
        publicBaseUrl: 'https://media.alphacity.tech',
        prefix: 'collections',
        outputDirectory: path.join(project, 'upload-stage'),
    });
    const remote = new Map();
    const calls = [];
    let active = 0;
    let maxActive = 0;
    async function runner(program, args) {
        calls.push({ program, args: [...args] });
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
            await new Promise((resolve) => setTimeout(resolve, 2));
            const cliArgs = args.slice(1);
            const action = cliArgs[2];
            const objectPath = cliArgs[3];
            const filePath = cliArgs[cliArgs.indexOf('--file') + 1];
            if (action === 'get') {
                if (!remote.has(objectPath)) return { status: 1, stdout: '', stderr: 'NoSuchKey' };
                fs.writeFileSync(filePath, remote.get(objectPath));
                return { status: 0, stdout: 'downloaded', stderr: '' };
            }
            if (action === 'put') {
                remote.set(objectPath, fs.readFileSync(filePath));
                return { status: 0, stdout: 'uploaded', stderr: '' };
            }
            return { status: 2, stdout: '', stderr: 'unexpected' };
        } finally {
            active -= 1;
        }
    }

    const uploadOptions = { wranglerJs: 'test-wrangler.js', runner, concurrency: 2, timeoutMs: 1_000 };
    const first = await publisher.uploadPublication(publication, uploadOptions);
    assert.equal(first.uploaded, publication.plan.objects.length);
    assert.equal(first.skipped, 0);
    assert.ok(maxActive <= 2 && maxActive > 1, 'remote operations use bounded concurrency');
    assert.ok(calls.every((call) => call.program === process.execPath));
    assert.ok(calls.every((call) => call.args[0] === 'test-wrangler.js'));
    assert.ok(calls.every((call) => !call.args.some((argument) => /token|secret/i.test(argument))));
    assert.ok(calls.filter((call) => call.args[3] === 'put').every((call) => call.args.includes('--remote')));

    calls.length = 0;
    const resumed = await publisher.uploadPublication(publication, uploadOptions);
    assert.equal(resumed.uploaded, 0);
    assert.equal(resumed.skipped, publication.plan.objects.length);
    assert.equal(calls.some((call) => call.args[3] === 'put'), false);

    const firstObjectPath = `${publication.plan.bucket}/${publication.plan.objects[0].key}`;
    remote.set(firstObjectPath, Buffer.from('different remote bytes'));
    calls.length = 0;
    await assert.rejects(
        () => publisher.uploadPublication(publication, uploadOptions),
        /already exists with different content.*Nothing was uploaded/,
    );
    assert.equal(calls.some((call) => call.args[3] === 'put'), false);
});

test('real runner invokes a JavaScript entrypoint through Node without a shell and enforces timeout', async (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alphacity-wrangler-runner-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const echoScript = path.join(directory, 'fake wrangler.js');
    fs.writeFileSync(echoScript, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    const literalArguments = ['literal&value', '$(not-a-command)', 'space value'];
    const result = await publisher.defaultWranglerRunner(process.execPath, [echoScript, ...literalArguments], {
        cwd: directory,
        timeoutMs: 1_000,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), literalArguments);

    const waitScript = path.join(directory, 'wait.js');
    fs.writeFileSync(waitScript, 'setInterval(() => {}, 1000);');
    const timedOut = await publisher.defaultWranglerRunner(process.execPath, [waitScript], {
        cwd: directory,
        timeoutMs: 50,
    });
    assert.equal(timedOut.timedOut, true);
});

test('CLI defaults to a network-free dry run', (context) => {
    const project = makeProject(context);
    const output = path.join(project, 'cli-stage');
    const stdout = execFileSync(process.execPath, [
        cli,
        project,
        '--bucket', 'alphacity-media',
        '--public-base-url', 'https://media.alphacity.tech',
        '--out', output,
        '--wrangler-js', path.join(project, 'definitely-not-installed-wrangler.js'),
    ], { encoding: 'utf8' });
    assert.match(stdout, /DRY RUN: .*no network request was made/);
    assert.equal(fs.existsSync(path.join(output, 'r2-media-manifest.json')), true);
});
